const fs = require('fs-extra')
const {createXXH3_128} = require('@kaciras-blog/nativelib')
const crypto = require('crypto')


class Util {

    /**
     * Returns true if the actual version is greater than
     * or equal to the desired version.
     *
     * @param {string} desired The desired version.
     * @param {string} actual The actual version.
     */
    static mcVersionAtLeast(desired, actual) {
        const des = desired.split('.')
        const act = actual.split('.')

        for (let i = 0; i < des.length; i++) {
            const aInt = act.length > i ? parseInt(act[i]) : 0
            const dInt = parseInt(des[i])
            if (aInt > dInt) {
                return true
            } else if (aInt < dInt) {
                return false
            }
        }
        return true
    }

    /**
     * Calculates the hash for a file using the specified algorithm.
     *
     * @param {string} filepath The buffer containing file data.
     * @param {string} algo The hash algorithm.
     * @returns {Promise} The calculated hash in hex.
     */
    static calculateHash(filepath, algo) {
        return new Promise((resolve, reject) => {
            if (algo === 'sha512' || algo === 'md5') {
                let hash = crypto.createHash(algo)
                let stream = fs.createReadStream(filepath)
                stream.on('error', reject)
                stream.on('data', chunk => hash.update(chunk))
                stream.on('end', () => resolve(hash.digest('hex')))
            } else if (algo === 'xxh128') {
                const hash = new createXXH3_128()
                const stream = fs.createReadStream(filepath)
                stream.on('error', reject)
                stream.on('data', chunk => hash.update(chunk))
                stream.on('end', () => {
                    resolve(hash.digest('hex'))
                })
            }
        })
    }

    /**
     * Validate that a file exists and matches a given hash value.
     *
     * @param {string} filePath The path of the file to validate.
     * @param {string} algo The hash algorithm to check against.
     * @param {string} hash The existing hash to check against.
     * @param {number} sizeBytes The expected size of the file in byte.
     * @returns {boolean} True if the file exists and calculated hash matches the given hash, otherwise false.
     */
    static async validateLocal(filePath, algo, hash, sizeBytes) {
        try {
            if (!await fs.pathExists(filePath)) {
                return false
            }
            if (sizeBytes != null) {
                const stats = await fs.stat(filePath)
                const currentSize = stats.size
                if (currentSize !== sizeBytes)
                    return false
            }
            if (hash != null) {
                const currentHash = await Util.calculateHash(filePath, algo)
                if (currentHash !== hash)
                    return false
            }
            return true
        } catch (e) {
            console.error(`Failed to validate file ${filePath}`, e)
            return false
        }
    }

}

module.exports = {
    Util,
}
