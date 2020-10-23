// Work in progress
const logger = require('./loggerutil')('%c[DiscordWrapper]', 'color: #7289da; font-weight: bold')

const {Client} = require('discord-rpc')

let client
let activity

exports.initRPC = function (discordSettings) {
    client = new Client({ transport: 'ipc' })

    if (discordSettings.nickname === '') {
        discordSettings.nickname = 'Странник'
    }

    if (discordSettings.guild === '' || discordSettings.guild === 'Без гильдии') {
        discordSettings.guild = '   '
        discordSettings.smallImageKey = '   '
        discordSettings.smallImageText = '   '
    }

    if (discordSettings.largeImageText === '') {
        discordSettings.largeImageText = 'Северный Клинок'
    }

    activity = {
        details: discordSettings.nickname,
        state: discordSettings.guild,
        largeImageKey: discordSettings.largeImageKey,
        largeImageText: discordSettings.largeImageText,
        smallImageKey: discordSettings.smallImageKey,
        smallImageText: discordSettings.smallImageText,
        startTimestamp: new Date().getTime(),
        instance: false
    }

    client.on('ready', () => {
        logger.log(`Nickname: "${discordSettings.nickname}", Guild: "${discordSettings.guild}", Large image key: "${discordSettings.largeImageKey}", Large image text "${discordSettings.largeImageText}"`)
        logger.log('Discord RPC Connected')
        client.setActivity(activity)
    })
    
    client.login({clientId: '742666702298546207'}).catch(error => {
        if(error.message.includes('ENOENT')) {
            logger.log('Unable to initialize Discord Rich Presence, no client detected.')
        } else {
            logger.log('Unable to initialize Discord Rich Presence: ' + error.message, error)
        }
        client = null
    })
}

exports.updateDetails = function(details){
    activity.details = details
    client.setActivity(activity)
}

exports.shutdownRPC = function(){
    if(!client) return
    client.clearActivity()
    client.destroy()
    client = null
    activity = null
}