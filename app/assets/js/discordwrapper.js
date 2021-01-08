// Work in progress
const logger = require('./loggerutil')('%c[DiscordWrapper]', 'color: #7289da; font-weight: bold')

const { Client } = require('discord-rpc')

let client
let activity

exports.initRPC = function (genSettings, servSettings, initialDetails = 'Waiting for Client..') {
    client = new Client({ transport: 'ipc' })

    activity = {
        details: '  ',
        state: '  ',
        largeImageKey: 'nbladelogo',
        largeImageText: 'Северный Клинок',
        smallImageKey: genSettings.smallImageKey,
        smallImageText: genSettings.smallImageText,
        startTimestamp: new Date().getTime(),
        instance: false
    }

    client.on('ready', () => {
        logger.log('Discord RPC Connected')
        client.setActivity(activity)
    })

    client.login({ clientId: '742666702298546207' }).catch(error => {
        if (error.message.includes('ENOENT')) {
            logger.log('Unable to initialize Discord Rich Presence, no client detected.')
        } else {
            logger.log('Unable to initialize Discord Rich Presence: ' + error.message, error)
        }
        client = null
    })
}

exports.updateDetails = function (details) {
    activity.details = details
    client.setActivity(activity)
}

exports.shutdownRPC = function () {
    if (!client) return
    client.clearActivity()
    client.destroy()
    client = null
    activity = null
}