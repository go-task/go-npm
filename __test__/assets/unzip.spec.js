const crypto = require('crypto');
const fs = require('fs');
const stream = require('stream');

const mockFs = require('mock-fs');
const nock = require('nock');
const request = require('request');

const unzip = require('../../src/assets/unzip');

// ZIP archive data of `command` file
// generated by `head -c 2 /dev/urandom > ./command` command
// and compressed by `zip ./test.zip ./command` command
const TEST_ZIP = {
  data: Buffer.from('UEsDBAoAAAAAAOKAxFbxsdyoAgAAAAIAAAAHABwAY29tbWFuZFVUCQADGDh8ZBg4fGR1eAsAAQT1AQAABBQAAADazFBLAQIeAwoAAAAAAOKAxFbxsdyoAgAAAAIAAAAHABgAAAAAAAEAAACkgQAAAABjb21tYW5kVVQFAAMYOHxkdXgLAAEE9QEAAAQUAAAAUEsFBgAAAAABAAEATQAAAEMAAAAAAA', 'base64'),
  sha256: {
    'command': '4a553e10c72a1df61b3601a2c402808e21fe6028209d1e6acfce26d451d738e3',
  },
};

class ChunkedDataReadable extends stream.Readable {
  /**
   * @param {Uint8Array} data
   * @param {number} [chunkSize]
   */
  constructor(data, chunkSize) {
    super();
    this._data = data;
    this._chunkSize = chunkSize;
    this._offset = 0;
  }

  /**
   * @param {number} size
   */
  _read(size) {
    const chunkSize = this._chunkSize != null ? this._chunkSize : size;
    if (this._offset < this._data.length) {
      this.push(this._data.subarray(this._offset, this._offset += chunkSize));
    } else {
      this.push(null);
    }
  }
}

/**
 * Disable functions that write to stdout, such as `console.log()`, and do not print anything from them.
 * @param {() => void} cb
 */
function ignoreStdoutWrite(cb) {
  const originalWrite = process.stdout.write;
  process.stdout.write = (...args) => {
    for (const arg of args) {
      if (typeof arg === 'function') {
        arg();
        break;
      }
    }
    return true;
  };
  cb();
  process.stdout.write = originalWrite;
}

/**
 * @param {string} algorithm
 * @param {string} filepath
 * @returns {Promise<string>}
 */
function createFileHash(algorithm, filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const fileStream = fs.createReadStream(filepath);
    fileStream.on('data', chunk => { hash.update(chunk) });
    fileStream.on('end', () => { resolve(hash.digest('hex')) });
    fileStream.on('error', reject);
  });
}

/**
 * Create mock functions `onSuccess` and `onError`, and a Promise object to wait until one of them is called
 */
function createCallbacks() {
  // Note: If `Promise.withResolvers` becomes available in the future, this code can be rewritten using it.
  //       See: https://github.com/tc39/proposal-promise-with-resolvers
  /** @type {() => void} */
  let finishCb;
  /** @type {Promise<void>} */
  const waitFinish = new Promise(resolve => {
    finishCb = resolve;
  });

  return {
    onSuccess: jest.fn(() => finishCb()),
    onError: jest.fn(() => finishCb()),
    /**
     * A Promise object to be resolved when onSuccess or onError is called.
     */
    waitFinish,
  };
}

describe('unzip()', () => {
  /**
   * Get the `Request` object returned by the `request()` function
   * @param {string} uri URL to send HTTP request
   * @param {Buffer | stream.Readable} expectedResponseBody Response body that should come back from the URL
   * @returns {Promise<request.Request>}
   */
  async function getReq(uri, expectedResponseBody) {
    const parsedUrl = new URL(uri);

    return await new Promise((resolve, reject) => {
      // Enable HTTP request mocking
      nock(parsedUrl.origin)
        .get(parsedUrl.pathname + parsedUrl.search)
        .reply(200, expectedResponseBody);

      // This code reproduces the logic of install.js
      // See: https://github.com/go-task/go-npm/blob/b3015dac197f7335b1da03759e707c5ee7ad4f27/src/actions/install.js#L37-L51
      const req = request({ uri });
      req.on('error', reject);
      req.on('response', () => { resolve(req) });
    });
  }

  beforeAll(async () => {
    // The following error occurs when the `console.log()` function is called in the test code:
    //     ENOENT: no such file or directory, lstat '.../node_modules/callsites'
    // Probably caused by having mock-fs enabled.
    // To work around this, call `console.log()` once here.
    ignoreStdoutWrite(() => console.log());
  });

  beforeEach(async () => {
    // Enable file system mocking
    mockFs({
      // Create a "./bin" directory in the virtual file system
      'bin': {},
    });

    // Disable all unnecessary HTTP requests
    nock.disableNetConnect();
  });

  afterEach(() => {
    // Unmock the file system
    mockFs.restore();

    // Unmock HTTP requests
    nock.cleanAll();
  });

  it('should download resource and unzip to given binPath', async () => {
    const req = await getReq(
      'https://example.com/releases/latest.zip',
      // Some unzip implementations may decompress invalid data if the ZIP archive is passed in multiple chunks.
      // See: https://github.com/ZJONSSON/node-unzipper/issues/271#issuecomment-1509961508
      // To test for such bugs, ZIP data is split into 1-byte chunks and passed to unzip.
      new ChunkedDataReadable(TEST_ZIP.data, 1),
    );
    const { onSuccess, onError, waitFinish } = createCallbacks();

    unzip({ opts: { binPath: './bin', binName: 'command' }, req, onSuccess, onError });

    await waitFinish;

    await expect(createFileHash('sha256', './bin/command'))
      .resolves.toEqual(TEST_ZIP.sha256['command']);
  });

  it('should call onSuccess on unzip close', async () => {
    const req = await getReq(
      'https://example.com/releases/latest.zip',
      TEST_ZIP.data,
    );
    const { onSuccess, onError, waitFinish } = createCallbacks();

    unzip({ opts: { binPath: './bin', binName: 'command' }, req, onSuccess, onError });

    await waitFinish;

    expect(onSuccess).toHaveBeenCalled();
  });

  it('should call onError with error on unzip error', async () => {
    const req = await getReq(
      'https://example.com/releases/latest.zip',
      // Returns an empty Buffer instead of ZIP data.
      // This should cause the unzip process to fail and throw an error.
      Buffer.alloc(0),
    );
    const { onSuccess, onError, waitFinish } = createCallbacks();

    unzip({ opts: { binPath: './bin', binName: 'command' }, req, onSuccess, onError });

    await waitFinish;

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
