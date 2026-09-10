#!/usr/bin/env python3
"""One-time root installation. Input is a reviewed publisher script and an SSH PUBLIC key."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess

ACCOUNT = 'cpredict-publish'
ROOT = Path('/var/www/cpredict-edge')
SCRIPT = Path('/usr/local/lib/cpredict/cloud-publisher.py')
KEYS = Path('/etc/ssh/cpredict-publish_authorized_keys')
CONFIG = Path('/etc/ssh/sshd_config.d/40-cpredict-publish.conf')
HOME = Path('/var/lib/cpredict-publish')


def run(args):
    result = subprocess.run(args, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError('installation check failed: ' + args[0])
    return result.stdout.decode()


def install(script, public_key):
    if os.geteuid() != 0:
        raise RuntimeError('root installation is required')
    key = public_key.read_text().strip()
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [A-Za-z0-9@._-]+)?', key):
        raise RuntimeError('expected one Ed25519 PUBLIC key')
    run(['ssh-keygen', '-lf', str(public_key)])
    source = script.read_bytes()
    compile(source, str(SCRIPT), 'exec')
    current = ROOT / 'current'
    if not current.is_symlink() or not (current / 'assets').is_dir():
        raise RuntimeError('existing public static release is required')
    previous = str(current.resolve())
    try:
        account = pwd.getpwnam(ACCOUNT)
        if account.pw_dir != str(HOME) or account.pw_uid == 0:
            raise RuntimeError('existing publisher account does not match')
    except KeyError:
        run(['useradd', '--system', '--home-dir', str(HOME), '--shell', '/bin/sh', '--password', '*', ACCOUNT])
        account = pwd.getpwnam(ACCOUNT)
    HOME.mkdir(mode=0o755, exist_ok=True)
    os.chown(HOME, 0, 0)
    HOME.chmod(0o755)
    SCRIPT.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
    if SCRIPT.is_symlink() or KEYS.is_symlink() or CONFIG.is_symlink():
        raise RuntimeError('installation destination is a link')
    SCRIPT.write_bytes(source)
    os.chown(SCRIPT, 0, 0)
    SCRIPT.chmod(0o644)
    KEYS.write_text('restrict ' + key + '\n')
    os.chown(KEYS, 0, 0)
    KEYS.chmod(0o644)
    before = CONFIG.read_bytes() if CONFIG.exists() else None
    CONFIG.write_text(f'''# Managed by Cpredict's one-time publisher installer.
Match User {ACCOUNT}
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile {KEYS}
    ForceCommand /usr/bin/python3 {SCRIPT}
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    PermitTunnel no
    MaxSessions 1
Match all
''')
    CONFIG.chmod(0o644)
    try:
        run(['/usr/sbin/sshd', '-t'])
        effective = run(['/usr/sbin/sshd', '-T', '-C', f'user={ACCOUNT},host=localhost,addr=127.0.0.1'])
        checks = [f'forcecommand /usr/bin/python3 {SCRIPT}', f'authorizedkeysfile {KEYS}',
                  'disableforwarding yes', 'permittty no', 'passwordauthentication no', 'permituserrc no']
        if not all(line in effective.splitlines() for line in checks):
            raise RuntimeError('existing SSH policy overrides publisher restrictions')
        for line in effective.splitlines():
            if line.startswith('allowusers ') and ACCOUNT not in line.split()[1:]:
                raise RuntimeError('existing AllowUsers needs an explicit publisher entry')
            if line.startswith('denyusers ') and ACCOUNT in line.split()[1:]:
                raise RuntimeError('existing DenyUsers prevents publishing')
        published = ROOT / 'published'
        if published.is_symlink():
            raise RuntimeError('published directory must not be a link')
        published.mkdir(mode=0o755, exist_ok=True)
        if current.resolve() != published.resolve():
            for file in (current / 'assets').rglob('*'):
                if file.is_symlink():
                    raise RuntimeError('existing asset is a link')
                dest = published / 'assets' / file.relative_to(current / 'assets')
                if file.is_dir():
                    dest.mkdir(parents=True, exist_ok=True, mode=0o755)
                elif file.is_file():
                    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                    if dest.exists() and hashlib.sha256(file.read_bytes()).digest() != hashlib.sha256(dest.read_bytes()).digest():
                        raise RuntimeError('existing asset collision')
                    shutil.copyfile(file, dest)
        for path in [published, *published.rglob('*')]:
            if path.is_symlink():
                raise RuntimeError('published data contains a link')
            os.chown(path, account.pw_uid, account.pw_gid)
            path.chmod(0o755 if path.is_dir() else 0o644)
        state = published / '.state'
        state.mkdir(mode=0o700, exist_ok=True)
        os.chown(state, account.pw_uid, account.pw_gid)
        state.chmod(0o700)
        for path in state.rglob('*'):
            path.chmod(0o700 if path.is_dir() else 0o600)
        # Keep the previous symlink target for an explicit installation rollback.
        evidence = ROOT / 'publisher-installation.json'
        if not evidence.exists():
            evidence.write_text(json.dumps({'previousStaticRoot': previous}) + '\n')
            evidence.chmod(0o600)
        temporary = ROOT / '.publisher-current'
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()
        temporary.symlink_to(published)
        os.replace(temporary, current)
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'ssh'])
    except Exception:
        if before is None:
            CONFIG.unlink(missing_ok=True)
        else:
            CONFIG.write_bytes(before)
        temporary = ROOT / '.publisher-rollback'
        if temporary.is_symlink():
            temporary.unlink()
        temporary.symlink_to(previous)
        os.replace(temporary, current)
        raise
    print(json.dumps({'installed': True, 'account': ACCOUNT,
                      'publisherSha256': hashlib.sha256(source).hexdigest(),
                      'hostPublicKey': Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().strip()}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--publisher', type=Path, required=True)
    parser.add_argument('--public-key', type=Path, required=True)
    args = parser.parse_args()
    install(args.publisher, args.public_key)
