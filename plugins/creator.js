function handler(m) {
  const data = global.owner.filter(([id, isCreator]) => id && isCreator)
  this.sendContact(m.chat, data.map(([id, name]) => [id, name]), m)
}
handler.help = ['owner', 'creator','pemilik']
handler.tags = ['info']

handler.command = /^(owner|creator|pemilik)$/i

export default handler
