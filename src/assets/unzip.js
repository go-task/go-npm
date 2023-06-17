const buffer = require('buffer');
const fs = require('fs').promises;
const { join } = require('path');
const { Writable } = require('stream');

const AdmZip = require('adm-zip');

/**
 * Reads the response body from the `Request` object and returns a `Buffer` object.
 * Preallocate memory for response body length based on HTTP Content-Length header, if available.
 * @param {import('request').Request} req
 * @returns {Promise<Buffer>}
 *
 * Note: This logic loads the entire contents of the ZIP file being downloaded into memory.
 *       This is not recommended as it consumes a lot of memory. Normally it should be written to a temporary file.
 *       However, the logic of adm-zip is similar: it loads the entire contents of the ZIP file into memory.
 *       See: https://github.com/cthackers/adm-zip/issues/417
 *            https://github.com/cthackers/adm-zip/blob/v0.5.10/adm-zip.js#L55
 *       So even if we write the zip to a temporary file, it does not change the behavior
 *       of loading the entire contents of the ZIP file into memory.
 *       In fact, more memory is used to read the file.
 *       For this reason, we use download logic that loads the entire contents of the ZIP file into memory.
 */
const getBody = (req) =>
  new Promise((resolve, reject) => {
    /** @type {{ readonly buf: Buffer, readonly reservedByteLength: number, updatedByteLength: number } | null | undefined} */
    let reservedMemory;
    /** @type {Buffer[]} */
    const chunkList = [];

    // If the Content-Length header is available, reserve the required amount of memory in advance.
    const contentLength = Number(
      req.response && req.response.headers['content-length']
    );
    if (
      Number.isInteger(contentLength) &&
      0 < contentLength &&
      contentLength <= buffer.constants.MAX_LENGTH
    ) {
      reservedMemory = {
        buf: Buffer.allocUnsafe(contentLength),
        reservedByteLength: contentLength,
        updatedByteLength: 0
      };
    }

    const dest = new Writable({
      write(chunk, encoding, done) {
        /** @type {Error | undefined} */
        let error;
        try {
          // Convert chunks to Buffer if possible
          if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
          }
          if (!Buffer.isBuffer(chunk)) return;

          // If the required memory is not allocated, add chunks to the `chunkList`
          if (!reservedMemory) {
            chunkList.push(chunk);
            return;
          }

          const newByteLength =
            reservedMemory.updatedByteLength + chunk.byteLength;
          if (newByteLength <= reservedMemory.reservedByteLength) {
            // If the byte length after writing is less than the reserved memory, write to it
            chunk.copy(reservedMemory.buf, reservedMemory.updatedByteLength);
            reservedMemory.updatedByteLength = newByteLength;
            return;
          }

          // If the byte length after writing is greater than the reserved memory
          // (i.e. the Content-Length header was less than the required length),
          // the reserved memory is added to `chunkList`, and subsequent chunks are also added to `chunkList`
          if (reservedMemory.updatedByteLength !== 0) {
            chunkList.push(
              // Slices only the written area from reserved memory
              // Note: Use the `.subarray()` method instead of the `.slice()` method, because `.slice()` always copies memory.
              reservedMemory.buf.subarray(0, reservedMemory.updatedByteLength)
            );
          }
          reservedMemory = null;
          chunkList.push(chunk);
        } catch (err) {
          error = err;
        } finally {
          done(error);
        }
      }
    });

    dest.on('error', reject);
    dest.on('finish', async () => {
      try {
        if (reservedMemory) {
          // If the chunk was written only to reserved memory
          // (i.e., the Content-Length header was equal to or greater than the required length),
          // use only the range written from here
          resolve(
            reservedMemory.buf.subarray(0, reservedMemory.updatedByteLength)
          );
        } else if (chunkList.length === 1) {
          // The `Buffer.concat()` function will always copy the Buffer object.
          // However, if the length of the array is 1, there is no need to copy it.
          resolve(chunkList[0]);
        } else {
          resolve(Buffer.concat(chunkList));
        }
      } catch (error) {
        reject(error);
      }
    });
    req.pipe(dest);
  });

/**
 * Unzip strategy for resources using `.zip`.
 *
 * Once unzip is completed, binary is downloaded into `binPath`.
 * Verify the binary and call it good.
 */
function unzip({ opts, req, onSuccess, onError }) {
  getBody(req)
    .then(async (zipData) => {
      const zip = new AdmZip(zipData);

      // Extract only the specified binary.
      const entry = zip.getEntry(opts.binName);
      if (!entry || entry.isDirectory) {
        // Leave error handling to `src/assets/binary.js` if the specified binary does not exist
        onSuccess();
        return;
      }

      // Note: The `zip.extractEntryTo()` function is not used because of its complicated behavior.
      const fileAttr = entry.header.fileAttr || 0o666;
      await fs.writeFile(join(opts.binPath, opts.binName), entry.getData(), {
        mode: fileAttr
      });

      onSuccess();
    })
    .catch(onError);
}

module.exports = unzip;
