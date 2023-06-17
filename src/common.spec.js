const fs = require('fs');
const childProcess = require('child_process');
const common = require('../src/common');
const path = require('path');

jest.mock('fs');
jest.mock('child_process');
jest.mock('mkdirp');

describe('common', () => {
  describe('getInstallationPath()', () => {
    let callback, _process;

    beforeEach(() => {
      callback = jest.fn();

      _process = { ...global.process, env: { ...process.env } };
    });

    afterEach(() => {
      global.process = _process;
    });

    it('should get binaries path from `npm bin`', () => {
      childProcess.exec.mockImplementationOnce((_cmd, cb) =>
        cb(null, path.sep + path.join('usr', 'local', 'bin'))
      );

      common.getInstallationPath(callback);

      expect(callback).toHaveBeenCalledWith(
        null,
        path.sep + path.join('usr', 'local', 'bin')
      );
    });

    it('should get binaries path from env on windows platform', () => {
      childProcess.exec.mockImplementationOnce((_cmd, cb) => cb(new Error()));

      process.platform = 'win32';
      process.env.npm_config_prefix = String.raw`C:\Users\John Smith\AppData\npm`;

      common.getInstallationPath(callback);

      expect(callback).toHaveBeenCalledWith(
        null,
        path.win32.join('C:', 'Users', 'John Smith', 'AppData', 'npm')
      );
    });

    it('should get binaries path from env on platform different than windows', () => {
      childProcess.exec.mockImplementationOnce((_cmd, cb) => cb(new Error()));

      process.platform = 'linux';
      process.env.npm_config_prefix = '/usr/local';

      common.getInstallationPath(callback);

      expect(callback).toHaveBeenCalledWith(
        null,
        path.sep + path.join('usr', 'local', 'bin')
      );
    });

    it('should call callback with error if binaries path is not found', () => {
      childProcess.exec.mockImplementationOnce((_cmd, cb) => cb(new Error()));

      process.env.npm_config_prefix = undefined;
      process.env.npm_config_local_prefix = undefined;

      common.getInstallationPath(callback);

      expect(callback).toHaveBeenCalledWith(
        new Error('Error finding binary installation directory')
      );
    });

    it('should call callback with error if binaries path is not found (avoid bug where npm does not set exit code in Node.js 20)', () => {
      // In Node.js 20, the behavior of the `process.exit()` function has changed.
      // As a result, npm 7.19.0 or later does not set the correct exit code on error.
      // see https://github.com/npm/cli/issues/6399
      // Therefore, the `child_process.exec()` function will not return an error.

      // This bug was fixed in npm 9.6.7, but not all users are running the latest version of npm.
      // In particular, in the environment of users using yarn or pnpm,
      // npm will remain at the old version built into Node.js and will not be updated to the new one.
      // So the `getInstallationPath()` function also needs to work around this bug.

      childProcess.exec.mockImplementationOnce((_cmd, cb) =>
        cb(
          null,
          'Unknown command: "bin"\n\nTo see a list of supported npm commands, run:\n  npm help\n',
          ''
        )
      );

      process.version = 'v20.0.0';
      process.versions = { ...process.versions, node: '20.0.0' };
      process.env.npm_config_prefix = undefined;
      process.env.npm_config_local_prefix = undefined;

      common.getInstallationPath(callback);

      expect(callback).toHaveBeenCalledWith(
        new Error('Error finding binary installation directory')
      );
    });
  });

  describe('getUrl', () => {
    it('should get url from given string url', () => {
      const url = common.getUrl('http://url');

      expect(url).toEqual('http://url');
    });

    it('should get specific url for current platform', () => {
      const url = common.getUrl(
        {
          default: 'http://url.tar.gz',
          windows: 'http://url.exe.zip'
        },
        { platform: 'win32' }
      );

      expect(url).toEqual('http://url.exe.zip');
    });

    it('should get default url for current platform', () => {
      const url = common.getUrl(
        {
          default: 'http://url.tar.gz',
          windows: 'http://url.exe.zip'
        },
        { platform: 'linux' }
      );

      expect(url).toEqual('http://url.tar.gz');
    });

    it('should get specific url for current platform and architecture', () => {
      const url = common.getUrl(
        {
          default: 'http://url.tar.gz',
          windows: 'http://url.exe.zip',
          darwin: {
            default: 'http://url_darwin.tar.gz',
            386: 'http://url_darwin_i386.tar.gz'
          }
        },
        { platform: 'darwin', arch: 'ia32' }
      );

      expect(url).toEqual('http://url_darwin_i386.tar.gz');
    });

    it('should get default url for current platform and architecture', () => {
      const url = common.getUrl(
        {
          default: 'http://url.tar.gz',
          windows: 'http://url.exe.zip',
          darwin: {
            default: 'http://url_darwin.tar.gz',
            386: 'http://url_darwin_i386.tar.gz'
          }
        },
        { platform: 'darwin', arch: 'amd64' }
      );

      expect(url).toEqual('http://url_darwin.tar.gz');
    });
  });

  describe('parsePackageJson()', () => {
    let _process;

    beforeEach(() => {
      _process = { ...global.process };
    });

    afterEach(() => {
      global.process = _process;
    });

    describe('validation', () => {
      it('should return if architecture is unsupported', () => {
        process.arch = 'mips';

        expect(common.parsePackageJson()).toBeUndefined();
      });

      it('should return if platform is unsupported', () => {
        process.platform = 'amiga';

        expect(common.parsePackageJson()).toBeUndefined();
      });

      it('should return if package.json does not exist', () => {
        fs.existsSync.mockReturnValueOnce(false);

        expect(common.parsePackageJson()).toBeUndefined();
      });
    });

    describe('variable replacement', () => {
      it('should append .exe extension on windows platform', () => {
        fs.existsSync.mockReturnValueOnce(true);
        fs.readFileSync.mockReturnValueOnce(
          JSON.stringify({
            version: '1.0.0',
            goBinary: {
              name: 'command',
              path: './bin',
              url: 'https://github.com/foo/bar/releases/v{{version}}/assets/command{{win_ext}}'
            }
          })
        );

        process.platform = 'win32';

        expect(common.parsePackageJson()).toMatchObject({
          binName: 'command.exe',
          url: 'https://github.com/foo/bar/releases/v1.0.0/assets/command.exe'
        });
      });

      it('should not append .exe extension on platform different than windows', () => {
        fs.existsSync.mockReturnValueOnce(true);
        fs.readFileSync.mockReturnValueOnce(
          JSON.stringify({
            version: '1.0.0',
            goBinary: {
              name: 'command',
              path: './bin',
              url: 'https://github.com/foo/bar/releases/v{{version}}/assets/command{{win_ext}}'
            }
          })
        );

        process.platform = 'darwin';

        expect(common.parsePackageJson()).toMatchObject({
          binName: 'command',
          url: 'https://github.com/foo/bar/releases/v1.0.0/assets/command'
        });
      });
    });
  });
});
