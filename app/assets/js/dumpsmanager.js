const fs = require('fs-extra')
const util = require('util')
const Registry = require('winreg')

const ConfigManager = require('./configmanager')

exports.createRule = async function (binaryName) {
    let regKey = new Registry({
        hive: Registry.HKCU,
        key: `\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\${binaryName}`,

    })

    const akeyExists = util.promisify(regKey.keyExists).bind(regKey)
    const acreate = util.promisify(regKey.create).bind(regKey)
    const aset = util.promisify(regKey.set).bind(regKey)

    let keyExists = await akeyExists()
    if (!keyExists) {
        await acreate()
    }
    const dumpsDirectory = ConfigManager.getCrashDumpDirectory()
    await fs.promises.mkdir(dumpsDirectory, {recursive: true})
    await Promise.all([
        aset('DumpFolder', Registry.REG_EXPAND_SZ, dumpsDirectory),
        aset('DumpCount', Registry.REG_DWORD, '3'),
        aset('DumpType', Registry.REG_DWORD, '1'),
    ])
}