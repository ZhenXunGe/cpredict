import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('cloud-publisher.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive(files=None, change_manifest=None, extra=None):
    files = files or {'assets/site-a1.js': b'x' * 2048}
    manifest = {'version': 1, 'sourceCommit': 'a' * 40, 'htmlSha256': 'b' * 64,
                'htmlAssets': [next(iter(files))], 'files': [
                    {'path': name, 'bytes': len(data), 'sha256': module.digest(data)} for name, data in files.items()]}
    if change_manifest:
        change_manifest(manifest)
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.USTAR_FORMAT) as tar:
        for name, data in {'release.json': json.dumps(manifest).encode(), **files}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
        if extra:
            tar.addfile(extra)
    data = stream.getvalue()
    return module.digest(data), data


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.publisher = module.Publisher(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def upload(self, pair):
        release, data = pair
        return self.publisher.dispatch(f'upload {release} {len(data)}', io.BytesIO(data))

    def test_upload_replay_activation_and_retained_rollback_assets(self):
        one = archive()
        first = self.upload(one)
        self.assertEqual(first, self.upload(one))
        self.assertNotIn('manifest', first)
        self.assertIsNone(self.publisher.current()['release'])
        self.publisher.activate(one[0], None)
        two = archive({'assets/site-b2.js': b'new'})
        self.upload(two)
        self.publisher.activate(two[0], one[0])
        self.publisher.activate(one[0], two[0])
        self.assertTrue((self.root / 'assets/site-b2.js').exists())
        self.assertEqual(self.publisher.activate(one[0], 'c' * 64)['release'], one[0])

    def test_rejects_unknown_and_concurrent_activation(self):
        one, two = archive(), archive({'assets/b.js': b'new'})
        self.upload(one)
        self.upload(two)
        self.publisher.activate(one[0], None)
        with self.assertRaises(module.PublishError): self.publisher.activate(two[0], None)
        with self.assertRaises(module.PublishError): self.publisher.activate('f' * 64, one[0])

    def test_digest_and_size_failures_do_not_publish(self):
        release, data = archive()
        for digest, size, stream in [('f' * 64, len(data), data), (release, len(data), data[:-1]), (release, len(data), data + b'!')]:
            with self.assertRaises(module.PublishError): self.publisher.upload(digest, size, io.BytesIO(stream))
        self.assertEqual(list((self.root / 'assets').iterdir()), [])

    def test_manifest_mismatch_does_not_publish_partial_files(self):
        pair = archive({'assets/good.js': b'ok', 'assets/bad.js': b'bad'},
                       lambda m: m['files'][1].update(sha256='0' * 64))
        with self.assertRaises(module.PublishError): self.upload(pair)
        self.assertEqual(list((self.root / 'assets').iterdir()), [])

    def test_rejects_traversal_links_and_special_files(self):
        for name in ['../escape', 'assets/../escape.js', '/assets/x.js', 'assets/.hidden', 'assets/a.gz', 'assets/a.map']:
            with self.assertRaises(module.PublishError): self.upload(archive({name: b'bad'}))
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE]:
            entry = tarfile.TarInfo('assets/link')
            entry.type, entry.linkname = kind, '/etc/passwd'
            with self.assertRaises(module.PublishError): self.upload(archive(extra=entry))

    def test_immutable_filename_collision(self):
        self.upload(archive({'assets/site.js': b'original'}))
        with self.assertRaises(module.PublishError): self.upload(archive({'assets/site.js': b'replaced'}))
        self.assertEqual((self.root / 'assets/site.js').read_bytes(), b'original')

    def test_rejects_existing_parent_symlink(self):
        (self.root / 'assets/sub').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(module.PublishError): self.upload(archive({'assets/sub/x.js': b'x'}))

    def test_private_state_public_modes_and_gzip_integrity(self):
        pair = archive({'assets/sub/site.js': b'a' * 2048})
        old = module.os.umask(0o077)
        try: self.upload(pair)
        finally: module.os.umask(old)
        self.assertEqual((self.root / '.state').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / 'assets/sub').stat().st_mode & 0o777, 0o755)
        path = self.root / 'assets/sub/site.js'
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        self.assertEqual(gzip.decompress(path.with_suffix('.js.gz').read_bytes()), path.read_bytes())

    def test_only_fixed_commands_are_allowed(self):
        for command in ['', 'sh', 'cat /etc/passwd', 'status; id', 'scp -t assets', 'upload abc 10', 'activate nope none']:
            with self.assertRaises(module.PublishError): self.publisher.dispatch(command, io.BytesIO())


if __name__ == '__main__':
    unittest.main()
