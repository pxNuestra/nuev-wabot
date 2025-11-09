// @ts-ignore
import path from 'path'
import storeSystem from './store.js'
import Helper from './helper.js'
import { HelperConnection } from './simple.js'
import importFile from './import.js'
import db, { loadDatabase } from './database.js'
import single2multi from './single2multi.js'
import P from 'pino'

import * as baileys from '@whiskeysockets/baileys'
const {
    makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    jidDecode
} = baileys

// Setup auth folder & file
const authFolder = storeSystem.fixFileName(`${Helper.opts._[0] || ''}sessions`)
const authFile = `${Helper.opts._[0] || 'session'}.data.json`

let [
    isCredsExist,
    isAuthSingleFileExist,
    authState
] = await Promise.all([
    Helper.checkFileExists(authFolder + '/creds.json'),
    Helper.checkFileExists(authFile),
    useMultiFileAuthState(authFolder)
])

const store = storeSystem.makeInMemoryStore()

// Convert single auth to multi auth
if (Helper.opts['singleauth'] || Helper.opts['singleauthstate']) {
    if (!isCredsExist && isAuthSingleFileExist) {
        console.debug('- singleauth - compiling singleauth to multiauth...')
        await single2multi(authFile, authFolder, authState)
        console.debug('- singleauth - compiled successfully')
        authState = await useMultiFileAuthState(authFolder)
    } else if (!isAuthSingleFileExist) console.error('- singleauth - singleauth file not found')
}

const storeFile = `${Helper.opts._[0] || 'data'}.store.json`
store.readFromFile(storeFile)

// Logger
const logger = P({
    level: 'warn',
    transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:standard' }
    }
}).child({ class: 'baileys' });

/** @type {import('@whiskeysockets/baileys').UserFacingSocketConfig} */
const connectionOptions = {
    auth: {
        creds: authState.state,
        keys: makeCacheableSignalKeyStore(authState.state.keys, logger)
    },
    logger
}

/** @type {Map<string, any>} */
let conns = new Map();

/** @param {any} oldSocket @param {any} opts */
async function start(oldSocket = null, opts = { store, logger, authState }) {

    let conn = makeWASocket({
        ...connectionOptions,
        ...opts.connectionOptions,
        auth: opts.authState.state,
        getMessage: async (key) => (
            opts.store.loadMessage(key.remoteJid, key.id) ||
            opts.store.loadMessage(key.id) || {}
        ).message || { conversation: 'Please send messages again' },
    })

    // Event QR
    conn.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
        if (qr) console.log('\n📱 Scan QR code ini untuk login WhatsApp:', qr)

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log(`Connection closed. ${shouldReconnect ? 'Reconnecting...' : 'Logged out.'}`)
            if (shouldReconnect) reload(conn)
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp as', conn.user?.id || '(unknown)')
        }
    })

    // Init helper
    HelperConnection(conn, { store: opts.store, logger })

    if (oldSocket) {
        conn.isInit = oldSocket.isInit
        conn.isReloadInit = oldSocket.isReloadInit
    }
    if (conn.isInit == null) {
        conn.isInit = false
        conn.isReloadInit = true
    }

    store.bind(conn.ev, { groupMetadata: conn.groupMetadata })

    await reload(conn, false, opts).then(success => console.log('- bind handler event -', success))

    return conn
}

/** @param {any} conn @param {boolean} restartConnection @param {any} opts */
async function reload(conn, restartConnection, opts = { store, authState }) {
    if (!opts.handler) opts.handler = importFile(Helper.__filename(path.resolve('./handler.js'))).catch(console.error)
    if (opts.handler instanceof Promise) opts.handler = await opts.handler

    const isReloadInit = !!conn.isReloadInit

    if (restartConnection) {
        try { conn.ws.close() } catch {}
        conn.ev.removeAllListeners()
        Object.assign(conn, await start(conn, opts) || {})
    }

    Object.assign(conn, getMessageConfig())

    if (!isReloadInit) {
        if (conn.handler) conn.ev.off('messages.upsert', conn.handler)
        if (conn.participantsUpdate) conn.ev.off('group-participants.update', conn.participantsUpdate)
        if (conn.groupsUpdate) conn.ev.off('groups.update', conn.groupsUpdate)
        if (conn.onDelete) conn.ev.off('messages.delete', conn.onDelete)
        if (conn.connectionUpdate) conn.ev.off('connection.update', conn.connectionUpdate)
        if (conn.credsUpdate) conn.ev.off('creds.update', conn.credsUpdate)
    }

    if (opts.handler) {
        conn.handler = opts.handler.handler.bind(conn)
        conn.participantsUpdate = opts.handler.participantsUpdate.bind(conn)
        conn.groupsUpdate = opts.handler.groupsUpdate.bind(conn)
        conn.onDelete = opts.handler.deleteUpdate.bind(conn)
    }

    if (!opts.isChild) conn.connectionUpdate = connectionUpdate.bind(conn, opts)
    conn.credsUpdate = opts.authState.saveCreds.bind(conn)

    conn.ev.on('messages.upsert', conn.handler)
    conn.ev.on('group-participants.update', conn.participantsUpdate)
    conn.ev.on('groups.update', conn.groupsUpdate)
    conn.ev.on('messages.delete', conn.onDelete)
    if (!opts.isChild) conn.ev.on('connection.update', conn.connectionUpdate)
    conn.ev.on('creds.update', conn.credsUpdate)

    conn.isReloadInit = false
    return true
}

/** @this {any} */
async function connectionUpdate(opts, update) {
    opts.logger?.info(update)
    const { connection, lastDisconnect } = update
    const code = lastDisconnect?.error?.output?.statusCode
    if (code && code !== DisconnectReason.loggedOut && this?.ws.readyState !== 0) {
        console.log(await reload(this, true, opts).catch(console.error))
    }
    if (connection == 'open') console.log('- opened connection -')

    if (db.data == null) loadDatabase()
}

function getMessageConfig() {
    return {
        welcome: 'Hai, @user!\nSelamat datang di grup @subject\n\n@desc',
        bye: 'Selamat tinggal @user!',
        spromote: '@user sekarang admin!',
        sdemote: '@user sekarang bukan admin!',
        sDesc: 'Deskripsi telah diubah ke \n@desc',
        sSubject: 'Judul grup telah diubah ke \n@subject',
        sIcon: 'Icon grup telah diubah!',
        sRevoke: 'Link group telah diubah ke \n@revoke'
    }
}

// Start connection
const conn = start(null, { store, logger, authState }).catch(console.error)

export default { start, reload, conn, conns, logger, connectionOptions, authFolder, storeFile, authState, store, getMessageConfig }
export { conn, conns, logger, jidDecode }
