#!/usr/bin/env python3
"""Forced-command SSH endpoint. Publishes immutable site assets; never runs a shell."""
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sys
import tarfile
import tempfile

ROOT = Path('/var/www/cpredict-edge/published')
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_UNPACKED = 128 * 1024 * 1024
HEX = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')


class PublishError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise PublishError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_json(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write((json.dumps(data, sort_keys=True) + '\n').encode())
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)


def validate_manifest(value):
    require(isinstance(value, dict) and value.get('version') == 1, 'unsupported manifest')
    require(COMMIT.fullmatch(str(value.get('sourceCommit', ''))), 'invalid source commit')
    require(HEX.fullmatch(str(value.get('htmlSha256', ''))), 'invalid HTML digest')
    files = value.get('files')
    require(isinstance(files, list) and 0 < len(files) <= 10000, 'invalid file count')
    seen = set()
    total = 0
    for row in files:
        require(isinstance(row, dict), 'invalid file entry')
        name = row.get('path', '')
        require(isinstance(name, str) and re.fullmatch(r'assets/[A-Za-z0-9_@+./-]+', name), 'invalid asset path')
        parts = PurePosixPath(name).parts
        require(all(part not in ('.', '..') and not part.startswith('.') for part in parts), 'invalid path component')
        require(PurePosixPath(name).as_posix() == name and not name.endswith(('.map', '.gz')), 'noncanonical asset path')
        require(name not in seen, 'duplicate asset')
        seen.add(name)
        require(type(row.get('bytes')) is int and 0 <= row['bytes'] <= MAX_UNPACKED, 'invalid asset size')
        require(HEX.fullmatch(str(row.get('sha256', ''))), 'invalid asset digest')
        total += row['bytes']
    require(total <= MAX_UNPACKED, 'unpacked limit exceeded')
    refs = value.get('htmlAssets')
    require(isinstance(refs, list) and refs and all(name in seen for name in refs), 'HTML references missing assets')
    return {row['path']: row for row in files}


class Publisher:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        require(self.root.is_dir() and not self.root.is_symlink(), 'publisher is not installed')
        self.state = self.root / '.state'
        self.state.mkdir(mode=0o700, exist_ok=True)
        require(not self.state.is_symlink(), 'invalid state directory')
        self.state.chmod(0o700)
        self.assets = self.root / 'assets'
        self.assets.mkdir(mode=0o755, exist_ok=True)
        require(not self.assets.is_symlink(), 'invalid assets directory')
        self.assets.chmod(0o755)

    def current(self):
        path = self.state / 'current.json'
        return json.loads(path.read_text()) if path.exists() else {'release': None, 'sourceCommit': None}

    def receipt(self, release):
        require(HEX.fullmatch(release), 'invalid release')
        path = self.state / (release + '.json')
        require(path.is_file() and not path.is_symlink(), 'release is not prepared')
        return json.loads(path.read_text())

    def upload(self, release, size, source):
        require(HEX.fullmatch(release), 'invalid archive digest')
        require(type(size) is int and 0 < size <= MAX_ARCHIVE, 'archive limit exceeded')
        with tempfile.TemporaryDirectory(prefix='upload-', dir=self.state) as temporary:
            stage = Path(temporary)
            archive = stage / 'assets.tar.gz'
            remaining = size
            sha = hashlib.sha256()
            with archive.open('xb') as handle:
                while remaining:
                    data = source.read(min(1024 * 1024, remaining))
                    require(data, 'incomplete upload')
                    remaining -= len(data)
                    sha.update(data)
                    handle.write(data)
                require(source.read(1) == b'', 'upload exceeds declared size')
            require(sha.hexdigest() == release, 'archive digest mismatch')
            prepared = self.state / (release + '.json')
            if prepared.exists():
                return self.receipt(release)
            unpacked = stage / 'unpacked'
            unpacked.mkdir()
            with tarfile.open(archive, 'r:gz') as bundle:
                members = []
                seen = set()
                total = 0
                for member in bundle:
                    require(len(members) < 12000, 'too many archive members')
                    require(member.isfile() or member.isdir(), 'links and special files are forbidden')
                    path = PurePosixPath(member.name)
                    require(not path.is_absolute() and all(not part.startswith('.') for part in path.parts), 'unsafe archive path')
                    require('\\' not in member.name and not any(ord(c) < 32 for c in member.name), 'unsafe archive name')
                    name = path.as_posix()
                    require(name not in seen and (name in ('release.json', 'assets') or name.startswith('assets/')), 'unexpected archive member')
                    seen.add(name)
                    total += member.size
                    require(total <= MAX_UNPACKED + 2 * 1024 * 1024, 'expanded archive limit exceeded')
                    if name == 'release.json':
                        require(member.isfile() and member.size <= 2 * 1024 * 1024, 'invalid manifest size')
                    members.append(member)
                manifests = [member for member in members if member.name == 'release.json']
                require(len(manifests) == 1, 'manifest is missing')
                with bundle.extractfile(manifests[0]) as handle:
                    manifest = json.load(handle)
                expected = validate_manifest(manifest)
                actual = {member.name for member in members if member.isfile() and member.name != 'release.json'}
                require(actual == set(expected), 'manifest does not match archive')
                # Verify the entire input before adding anything to the public directory.
                for member in members:
                    if not member.isfile() or member.name == 'release.json':
                        continue
                    row = expected[member.name]
                    require(member.size == row['bytes'], 'asset size mismatch')
                    with bundle.extractfile(member) as handle:
                        data = handle.read()
                    require(digest(data) == row['sha256'], 'asset digest mismatch')
                    target = unpacked / member.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    destination = self.root / member.name
                    # Every existing parent is trusted only if it is a real directory.
                    parent = destination.parent
                    while parent != self.root:
                        require(not parent.is_symlink(), 'asset parent is a link')
                        parent = parent.parent
                    if destination.exists() or destination.is_symlink():
                        require(destination.is_file() and not destination.is_symlink(), 'invalid existing asset')
                        require(digest(destination.read_bytes()) == row['sha256'], 'immutable filename collision')
                for name, row in expected.items():
                    target = self.root / name
                    if not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                        parent = target.parent
                        while parent != self.root:
                            parent.chmod(0o755)
                            parent = parent.parent
                        temporary_file = target.parent / ('.upload-' + release)
                        shutil.copyfile(unpacked / name, temporary_file)
                        temporary_file.chmod(0o644)
                        os.replace(temporary_file, target)
                    if target.suffix in ('.js', '.css', '.svg') and row['bytes'] >= 1024:
                        compressed = target.with_name(target.name + '.gz')
                        require(not compressed.is_symlink(), 'compressed asset is a link')
                        if not compressed.exists() or gzip.decompress(compressed.read_bytes()) != target.read_bytes():
                            temp_gz = compressed.parent / ('.gzip-' + release)
                            temp_gz.write_bytes(gzip.compress(target.read_bytes(), compresslevel=6, mtime=0))
                            temp_gz.chmod(0o644)
                            os.replace(temp_gz, compressed)
            result = {'release': release, 'sourceCommit': manifest['sourceCommit'],
                      'htmlSha256': manifest['htmlSha256'], 'fileCount': len(expected),
                      'manifest': manifest, 'prepared': True}
            atomic_json(prepared, result)
            return result

    def activate(self, release, previous):
        receipt = self.receipt(release)
        current = self.current()
        # A lost SSH reply can be reconciled using status without activating twice.
        if current.get('release') == release:
            return current
        require(current.get('release') == previous, 'active release changed')
        for row in receipt['manifest']['files']:
            path = self.root / row['path']
            require(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == row['sha256'], 'prepared asset changed')
        result = {'release': release, 'sourceCommit': receipt['sourceCommit'],
                  'htmlSha256': receipt['htmlSha256'], 'fileCount': receipt['fileCount']}
        atomic_json(self.state / 'current.json', result)
        return result

    def dispatch(self, command, source):
        args = command.split(' ')
        with (self.state / 'publish.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if args == ['status']:
                return {'protocol': 1, **self.current()}
            if len(args) == 3 and args[0] == 'upload' and re.fullmatch(r'[1-9][0-9]{0,8}', args[2]):
                result = self.upload(args[1], int(args[2]), source)
                return {key: value for key, value in result.items() if key != 'manifest'}
            if len(args) == 3 and args[0] == 'activate' and (args[2] == 'none' or HEX.fullmatch(args[2])):
                return self.activate(args[1], None if args[2] == 'none' else args[2])
            raise PublishError('command is not allowed')


def main():
    signal.alarm(600)
    os.umask(0o077)
    try:
        require(len(sys.argv) == 1, 'arguments are not allowed')
        command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
        require(len(command) <= 256 and '\n' not in command and '\r' not in command, 'invalid command')
        result = Publisher().dispatch(command, sys.stdin.buffer)
        print(json.dumps(result))
    except (PublishError, OSError, ValueError, tarfile.TarError) as error:
        # Do not echo client input, local paths, or environment values.
        reason = str(error) if isinstance(error, PublishError) else type(error).__name__
        print(json.dumps({'error': reason}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
