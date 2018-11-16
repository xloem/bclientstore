const BclientStore = require('./bclientstore')
const bclient = require('bclient')
const bcoin = require('bcoin')

const NETWORK = 'testnet'
const PASSPHRASE = 'test'
const ADDRESS = 'tb1qvh4v4kx8yut9d54usawq724ecnrtzju4j7300f'

const network = bcoin.Network.get(NETWORK)
const nodeclient = new bclient.NodeClient({network: network.type, port: network.rpcPort, timeout: 90000})
const walletclient = new bclient.WalletClient({network: network.type, port: network.walletPort, timeout: 90000})

const store = new BclientStore(nodeclient, walletclient, PASSPHRASE)

async function go() {
  const info = await store._lookup(ADDRESS)
  history = await store._wallet.getHistory(info.wallet)
  console.log('Before transaction, history size = ' + history.length)
  await store.write(ADDRESS, '1')
  history = await store._wallet.getHistory(info.wallet)
  console.log('After transaction, history size = ' + history.length)
}

go()
