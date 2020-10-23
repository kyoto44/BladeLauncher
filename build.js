const builder = require('electron-builder')
const Platform = builder.Platform

function getCurrentPlatform() {
    switch (process.platform) {
        case 'win32':
            return Platform.WINDOWS
        case 'darwin':
            return Platform.MAC
        case 'linux':
            return Platform.linux
        default:
            console.error('Cannot resolve current platform!')
            return undefined
    }
}

builder.build({
    targets: (process.argv[2] != null && Platform[process.argv[2]] != null ? Platform[process.argv[2]] : getCurrentPlatform()).createTarget(),
    config: {
        appId: 'nblade.bladelauncher',
        productName: 'Blade Launcher',
        artifactName: '${productName}-setup-${version}.${ext}',
        copyright: 'Copyright © 2019-2020 N-Blade LLC',
        directories: {
            buildResources: 'build',
            output: 'dist'
        },
        publish: [{
            provider: 'generic',
            url: 'http://downloads.n-blade.ru/launcher/'
        }],
        win: {
            icon: 'app/assets/images/SealCircle.ico',
            target: [
                {
                    target: 'nsis',
                    arch: 'x64'
                }
            ],
            legalTrademarks: 'N-blade'
        },
        nsis: {
            oneClick: true,
            perMachine: false,
            allowElevation: true,
            allowToChangeInstallationDirectory: false,
            deleteAppDataOnUninstall: true,
            language: '1049'
        },
        mac: {
            target: 'dmg',
            category: 'public.app-category.games'
        },
        linux: {
            target: 'AppImage',
            maintainer: 'N-Blade LLC',
            vendor: 'N-Blade LLC',
            synopsis: 'Northern Blade Launcher',
            description: 'Game launcher which allows users to join servers and handle updates automatically.',
            category: 'Game'
        },
        compression: 'maximum',
        files: [
            '!{dist,.gitignore,.vscode,docs,dev-app-update.yml,.travis.yml,.nvmrc,.eslintrc.json,build.js}'
        ],
        extraResources: [
            'libraries'
        ],
        asar: true
    }
}).then(() => {
    console.log('Build complete!')
}).catch(err => {
    console.error('Error during build!', err)
})
