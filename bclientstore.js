const bcoin = require('bcoin')
const bclient = require('bclient')

const BITCOIN_OPRETURN_SIZE = 220

class SizeError extends Error
{
  constructor(message, size)
  {
    super(message)
    this.size = size
  }
}

class BclientStore
{
  constructor (nodeClient, walletClient, walletPassphrase, feeRate = null)
  {
    this._node = nodeClient
    this._wallet = walletClient
    this._passphrase = walletPassphrase
    this._feeRate = feeRate
    this._infoByAddress = {}
  }

  async accounts ()
  {
    const valueByAddress = {}
    for (let wallet of await this._wallet.getWallets())
    {
      for (let coin of await this._wallet.getCoins(wallet))
      {
        if (!valueByAddress[coin.address])
        {
          valueByAddress[coin.address] = coin.value
        }
        else
        {
          valueByAddress[coin.address] += coin.value
        }
      }
    }
    const addresses = []
    for (let address in valueByAddress)
    {
      const info = await this._lookup(address)
      addresses.push({
        address: address,
        value: valueByAddress[address],
        label: info ? (info.wallet + (info.account !== 'default' ? '.' + info.account : '')) + '-' + info.branch + '-' + info.index: null
      })
    }
    return addresses
  }

  async write (address, data, opts = {})
  {
    if (!Buffer.isBuffer(data))
    {
      data = Buffer.from(data)
    }
    const walletInfo = await this._lookup(address)
    if (! walletInfo)
    {
      throw new Error('not following ' + address)
    }
    // TODO: optimize handling of locked coins
    //       this is mostly a workaround for https://github.com/bcoin-org/bcoin/issues/631
    const lockedCoins = {}
    for (let lockedCoin of await this._wallet.getLocked(walletInfo.wallet))
    {
      if (! lockedCoins[lockedCoin.hash])
      {
        lockedCoins[lockedCoin.hash] = { }
      }
      lockedCoins[lockedCoin.hash][lockedCoin.index] = true
    }
    const prevouts = opts.prevouts ? opts.prevouts : []
    for (let prevout of prevouts)
    {
      const txid = prevout.txid()
      if (! lockedCoins[txid])
      {
        lockedCoins[txid] = { }
      }
      lockedCoins[txid][prevout.index] = true

    }
    const coins = (await this._wallet.getCoins(walletInfo.wallet, walletInfo.account))
      .filter(coin => coin.address === address &&
        (!lockedCoins[coin.hash] || !lockedCoins[coin.hash][coin.index])
      )
      .map(coin => bcoin.primitives.Coin.fromJSON(coin))
      .concat(prevouts)

    if (coins.length === 0)
    {
      throw new Error('No matching balance found')
    }

    const mtx = new bcoin.primitives.MTX()
    let outputIdx = 0
    let dataOffset = 0
    const stride = opts.opreturnsize || BITCOIN_OPRETURN_SIZE
    for (; dataOffset < data.length; dataOffset += stride)
    {
      const script = new bcoin.script.Script()
      script.clear()
      script.pushOp(bcoin.script.common.opcodes.OP_RETURN)
      script.pushData(data.slice(dataOffset, dataOffset + stride < data.length ? dataOffset + stride : data.length))
      script.compile()
      mtx.outputs.push(bcoin.Output.fromScript(script, outputIdx ++))
    }
    if (opts.outputs)
    {
      for (let output of opts.outputs)
      {
        mtx.addOutput({value: output.value, address: output.address})
      }
    }
    await mtx.fund(
      coins,
      {
        changeAddress: address,
        rate: opts.feeRate || this._feeRate,
        maxFee: opts.maxFee,
        inputs: prevouts
      }
    )
    mtx.sortMembers()
    const masterkeyjson = await this._wallet.getMaster(walletInfo.wallet)
    var masterhd
    if (masterkeyjson.encrypted)
    {
      masterkeyjson.iv = Buffer.from(masterkeyjson.iv, 'hex')
      masterkeyjson.ciphertext = Buffer.from(masterkeyjson.ciphertext, 'hex')
      const mko = bcoin.wallet.MasterKey.fromOptions(masterkeyjson)
      await mko.decrypt(this._passphrase)
      masterhd = mko.key
    }
    else
    {
      masterhd = bcoin.hd.fromBase58(masterkeyjson.key.xprivkey)
    }
    const network = (await this._node.getInfo()).network
    const accountkey = masterhd.deriveAccount(44, bcoin.Network.get(network).keyPrefix.coinType, walletInfo.accountidx)
    const addrkey = accountkey.derive(walletInfo.branch).derive(walletInfo.index)
    mtx.sign(new bcoin.KeyRing(addrkey), bcoin.Script.hashType.ALL)

    if (mtx.getBaseSize() > bcoin.protocol.consensus.MAX_BLOCK_SIZE)
    {
      let extra = mtx.getBaseSize() - bcoin.protocol.consensus.MAX_BLOCK_SIZE
      throw new SizeError('Data is too long by ' + extra, data.length - extra)
    }
    
    mtx.check()
    let [sane, disorder] = mtx.checkSanity()
    if (! sane)
    {
      throw new Error('transaction failed sanity check: ' + disorder)
    }

    if (!opts.simulate)
    {
      await this._node.broadcast(mtx.toRaw().toString('hex'))
      
      for (let input of mtx.inputs)
      {
        await this._wallet.lockCoin(walletInfo.wallet, input.prevout.txid(), input.prevout.index)
      }
    }

    const outpoints = []
    for (let i = 0; i < mtx.outputs.length; i ++)
    {
      const address = mtx.outputs[i].getAddress()
      if (address)
      {
        outpoints.push(bcoin.primitives.Coin.fromTX(mtx, i, -1))
      }
    }
  
    return {
      txid: mtx.txid(),
      outs: outpoints,
      fee: mtx.getFee(),
      size: mtx.getBaseSize()
    }
  }

  async sync(address, txid, confirmations = 3)
  {
    const self = this
    const wallet = (await this._lookup(address)).wallet
    return await new Promise(function (resolve, reject)
      {
        checkNext()

        function checkTX(tx)
        {
          // called by getTX
          if (tx === null || tx.confirmations < confirmations)
          {
            setTimeout(checkNext, 60000)
          }
          else
          {
            resolve(tx)
          }
        }

        function checkNext()
        {
          // called by timeout
          self._wallet.getTX(wallet, txid).then(checkTX).catch(reject)
        }
      }
    )
  }

  // opts = {
  //  srcAddr: null
  //  dstAddr: null
  //  start: null
  //  end: null
  // }
  async read(opts)
  {
    // TODO: read all transactions when node is full and wallet unspecified
    const eitherAddr = opts.srcAddr || opts.dstAddr
    if (eitherAddr)
    {
      if (! opts.wallet || ! opts.account)
      {
        const walletInfo = (await this._lookup(opts.srcAddr)) || (await this._lookup(opts.dstAddr))
        opts.wallet = walletInfo.wallet
        opts.account = walletInfo.account
      }
      if (! opts.wallet)
      {
        opts.wallet = '_watchonly_witness'
        try
        {
          await this._wallet.createWallet(opts.wallet, { witness: true, watchOnly: true})
        }
        catch (e) {}
        
        opts.account = eitherAddr
        await this._wallet.createAccount(opts.account, {witness: true})
        
        await this._wallet.importAddress(opts.wallet, opts.account, eitherAddr)

        await this._node.reset(0)
      }
    }
    const txs = await (
        (opts.startDate || opts.endDate) ?
          this._wallet.getRange(opts.wallet, opts.account, {
            start: startDate.getTime() / 1000,
            end: endDate.getTime() / 1000
          }) :
          this._wallet.getHistory(opts.wallet, opts.account)
    )
    var result = []
    for (let tx of txs)
    {
      if (opts.srcAddr && tx.inputs.every(input => input.address !== opts.srcAddr))
      {
        continue
      }
      if (opts.dstAddr && tx.outputs.every(output => output.address !== opts.dstAddr))
      {
        continue
      }
      const txObj = bcoin.primitives.TX.fromRaw(tx.tx, 'hex')
      const inputArray = []
      for (let i = 0; i < txObj.inputs.length; i ++)
      {
        inputArray.push({
          value: tx.inputs[i].value,
          address: tx.inputs[i].address,
          txid: txObj.inputs[i].prevout.hash.toString('hex')
        })
      }
      const outputArray = []
      for (let i = 0; i < txObj.outputs.length; i ++)
      {
        const data = txObj.outputs[i].script.getNulldata()
        if (data)
        {
          outputArray.push({
            type: txObj.outputs[i].getType(),
            data: data
          })
        }
        else
        {
          outputArray.push({
            type: txObj.outputs[i].getType(),
            value: txObj.outputs[i].value,
            address: tx.outputs[i].address,
          })
        }
      }
      result.push({
        block: tx.height >= 0 ? tx.height : null,
        txid: tx.hash,
        dsts: outputArray,
        srcs: inputArray,
        time: tx.time
      })
    }
    return result
  }

  /*
  async getBlockCount ()
  {
    const info = await this._node.getInfo()
    return info.chain.height
  }
  */

  async _lookup(addr)
  {
    if (! addr)
    {
      return null
    }
    if (this._infoByAddress[addr])
    {
      return this._infoByAddress[addr]
    }
    for (let wallet of await this._wallet.getWallets())
    {
      const walletInfo = await this._wallet.getKey(wallet, addr)
      if (walletInfo)
      {
        return this._infoByAddress[addr] = {
          wallet: wallet,
          account: walletInfo.name,
          accountidx: walletInfo.account,
          branch: walletInfo.branch,
          index: walletInfo.index
        }
      }
    }
    return null
  }

  async _eventsUntil (eventName, handler, initialPromise)
  {
    const self = this
    return new Promise(
      function (resolve, reject)
      {
        function handleTimeout ()
        {
          self._wallet.socket.unbind(eventName, handleEvent)
          reject(new Error('timed out'))
        }

        function handleEvent (walletId, arg)
        {
          if (!arg) return
          if (handler(walletId, arg)) 
          {
            clearTimeout(timer)
            self._wallet.socket.unbind(eventName, handleEvent)
            resolve()
          }
        }

        const timer = setTimeout(handleTimeout, self._wallet.timeout)
        self._wallet.socket.bind(eventName, handleEvent)

        if (initialPromise)
        {
          initialPromise
            .then(x => handleEvent('', x))
            .catch(reject)
        }
      }
    )
  }
}

module.exports = BclientStore
