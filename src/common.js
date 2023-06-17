const { join, isAbsolute } = require('path');
const { exec } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const mkdirp = require('mkdirp');
const usedPM = require('used-pm');

// Mapping from Node's `process.arch` to Golang's `$GOARCH`
const ARCH_MAPPING = {
  ia32: '386',
  x64: 'amd64',
  arm: 'arm',
  arm64: 'arm64'
};

// Mapping between Node's `process.platform` to Golang's
const PLATFORM_MAPPING = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
  freebsd: 'freebsd'
};

function getInstallationPath(callback) {
  // `npm bin` will output the path where binary files should be installed
  exec('npm bin', (err, stdout, stderr) => {
    let dir = null;
    if (
      err ||
      stderr ||
      !stdout ||
      stdout.length === 0 ||
      // In Node.js 20, the behavior of the `process.exit()` function has changed.
      // As a result, npm 7.19.0 or later does not set the correct exit code on error.
      // Therefore, the `child_process.exec()` function will not return an `err`.
      // See: https://github.com/npm/cli/issues/6399
      // This bug was fixed in npm 9.6.7, but not all users are running the latest version of npm.
      // So if `stdout` is not an absolute path in a Node.js 20+ environment,
      // we treat it as if the `npm bin` command failed.
      //
      // Note: The most common failure of the `npm bin` command is the `Unknown command: "bin"` error, but other errors may occur.
      //       So it is not possible to determine the error from the contents of `stdout`.
      //       On the other hand, the `npm bin` command will never return a relative path.
      //       And the error message will never be in the format of an absolute path.
      //       Therefore, it should be possible to determine the error by determining whether `stdout` is an absolute path.
      (Number(process.versions.node.split('.')[0]) >= 20 &&
        !isAbsolute(stdout.trim()))
    ) {
      // We couldn't infer path from `npm bin`. Let's try to get it from
      // Environment variables set by NPM when it runs.
      // npm_config_prefix points to NPM's installation directory where `bin` folder is available
      // Ex: /Users/foo/.nvm/versions/node/v4.3.0
      const env = process.env;

      // Get the package manager who is running the script
      // This is needed since PNPM works in a different way than NPM or YARN.
      const packageManager = usedPM();

      if (env && env.npm_config_prefix) {
        if (process.platform === 'win32') {
          // On Windows, use the installation directory itself instead of the `bin` folder.
          // See: https://docs.npmjs.com/cli/v6/configuring-npm/folders#executables
          dir = env.npm_config_prefix;
        } else {
          dir = join(env.npm_config_prefix, 'bin');
        }
      } else if (env && env.npm_config_local_prefix) {
        dir = join(env.npm_config_local_prefix, join('node_modules', '.bin'));
      } else if (packageManager.name.toLowerCase() === 'pnpm') {
        dir = join(process.cwd(), 'node_modules', '.bin');
      } else {
        return callback(
          new Error('Error finding binary installation directory')
        );
      }
    } else {
      dir = stdout.trim();
    }

    dir = dir.replace(
      /node_modules.*[\/\\]\.bin/,
      join('node_modules', '.bin')
    );

    mkdirp.sync(dir);

    callback(null, dir);
  });
}

function validateConfiguration({ version, goBinary }) {
  if (!version) {
    return "'version' property must be specified";
  }

  if (!goBinary || typeof goBinary !== 'object') {
    return "'goBinary' property must be defined and be an object";
  }

  if (!goBinary.name) {
    return "'name' property is necessary";
  }

  if (!goBinary.path) {
    return "'path' property is necessary";
  }

  if (!goBinary.url) {
    return "'url' property is required";
  }
}

function getUrl(url, process) {
  if (typeof url === 'string') {
    return url;
  }

  let _url;

  if (url[PLATFORM_MAPPING[process.platform]]) {
    _url = url[PLATFORM_MAPPING[process.platform]];
  } else {
    _url = url.default;
  }

  if (typeof _url === 'string') {
    return _url;
  }

  if (_url[ARCH_MAPPING[process.arch]]) {
    _url = _url[ARCH_MAPPING[process.arch]];
  } else {
    _url = _url.default;
  }

  return _url;
}

function parsePackageJson() {
  if (!(process.arch in ARCH_MAPPING)) {
    console.error(
      'Installation is not supported for this architecture: ' + process.arch
    );
    return;
  }

  if (!(process.platform in PLATFORM_MAPPING)) {
    console.error(
      'Installation is not supported for this platform: ' + process.platform
    );
    return;
  }

  const packageJsonPath = join('.', 'package.json');
  if (!existsSync(packageJsonPath)) {
    console.error(
      'Unable to find package.json. ' +
        'Please run this script at root of the package you want to be installed'
    );
    return;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath));
  const error = validateConfiguration(packageJson);

  if (error && error.length > 0) {
    console.error('Invalid package.json: ' + error);
    return;
  }

  // We have validated the config. It exists in all its glory
  const binPath = packageJson.goBinary.path;
  let binName = packageJson.goBinary.name;
  let url = getUrl(packageJson.goBinary.url, process);
  let version = packageJson.version;

  if (!url) {
    console.error('Could not find url matching platform and architecture');
    return;
  }

  if (version[0] === 'v') version = version.substr(1); // strip the 'v' if necessary v0.0.1 => 0.0.1

  // Binary name on Windows has .exe suffix
  if (process.platform === 'win32') {
    binName += '.exe';

    url = url.replace(/{{win_ext}}/g, '.exe');
    url = url.replace(/{{archive_ext}}/g, '.zip');
  } else {
    url = url.replace(/{{win_ext}}/g, '');
    url = url.replace(/{{archive_ext}}/g, '.tar.gz');
  }

  // Interpolate variables in URL, if necessary
  url = url.replace(/{{arch}}/g, ARCH_MAPPING[process.arch]);
  url = url.replace(/{{platform}}/g, PLATFORM_MAPPING[process.platform]);
  url = url.replace(/{{version}}/g, version);
  url = url.replace(/{{bin_name}}/g, binName);

  return {
    binName,
    binPath,
    url,
    version
  };
}

module.exports = { parsePackageJson, getUrl, getInstallationPath };
