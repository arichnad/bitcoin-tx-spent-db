/**
 * Module dependencies.
 */
var express = require('express');
var winston = require('winston');
var Step = require('step');
var bitcoin = require('bitcoinjs');
var RpcClient = require('jsonrpc2').Client;
var bigint = global.bigint = bitcoin.bigint;
var Db = require('mongodb').Db
  , Connection = require('mongodb').Connection
  , Server = require('mongodb').Server;

var host = process.env['MONGO_NODE_DRIVER_HOST'] != null ? process.env['MONGO_NODE_DRIVER_HOST'] : 'localhost';
var port = process.env['MONGO_NODE_DRIVER_PORT'] != null ? process.env['MONGO_NODE_DRIVER_PORT'] : Connection.DEFAULT_PORT;

console.log("Connecting to " + host + ":" + port);
var db = new Db('test', new Server(host, port, {}), {native_parser:true});

global.Util = require('./util');
var fs = require('fs');

var init = require('bitcoinjs/daemon/init');
var config = init.getConfig();

var app = module.exports = express();

app.configure(function(){
  app.set('views',__dirname + '/views');
  app.set('view engine', 'jade'); app.set('view options', { layout: false });
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});

// Routes
app.get('/',function(req, res){
  res.render('home.jade',{})
})

function get(dbname, res, query) {
  db.open(function(err, db) {
    db.collection(dbname, function(err, collection) {
      collection.find(query).toArray(function(err, results) {
        if (err) return console.log(err)
        db.close()
        res.write(JSON.stringify(results))
        res.end()
      });
    })
  })
}

//Returns outputs for every given input
function bkMatchInputs(tx) {
    //Special case coinbase, sole input gets matched to everything
    var i=0;
    if (tx.in[0].type == 'coinbase') { return [tx.out.map(function() { i++; return i-1; })] } 

    //Everything else
    var inputs = [];
    var outputs = [0];
    var matching = [];

    // create prefix sums
    tx.out.reduce(function(prev, curr) {
        prev += parseFloat(curr.value);
        outputs.push(prev);
        return prev;
    }, 0);
    tx.in.reduce(function(prev, curr) {
        prev += parseFloat(curr.value)
        inputs.push(prev);
        return prev;
    }, 0);

    // matching algorithm
    var inIdx = 0; var outIdx = 0;
    for(var inIdx = 0;
        inIdx < inputs.length;
        ++inIdx)
    {
        matching[inIdx] = []

        for(; outIdx < outputs.length-1; outIdx++) {
            matching[inIdx].push(outIdx);
            if(outputs[outIdx+1] >= inputs[inIdx]) {
                break;
            }
        }
    }
    
    return matching;
}

app.get('/json/tx-v0/:txHash', function(req, res, next){
  hash = Util.decodeHex(req.params.txHash).reverse();
  var hash64 = hash.toString('base64');
  rpc.call('explorer.txquery', [hash64], function (err, tx) {
    if (err) return next(err);
    res.write(JSON.stringify(tx.tx));
    res.end();
  });
});


// this is just for testing what whatnot
app.get('/json/spendswhat/:txHash', function(req, res, next){
    var hash = req.params.txHash;
    console.log('spentdb: '+hash)
    get('spentdb', res, {txhash: hash});
});

app.get('/json/whospends/:txHash', function(req, res, next){
    var hash = req.params.txHash;
    console.log('spentdb: '+hash)
    get('spentdb', res, {prev_txhash: hash});
});

app.get('/json/whospends/:txHash/:oIndex', function(req, res, next){
    var hash = req.params.txHash;
    var oIndex = parseInt(req.params.oIndex, 10);
    console.log('spentdb: '+hash)
    get('spentdb', res, {prev_txhash: hash, prev_out_index: oIndex});
});

app.get('/json/dc/:txHash', function(req, res, next){
    var hash = req.params.txHash;
    console.log('dtocoinbase: '+hash)
    get('dtocoinbase', res, {txhash: hash});
});

app.get('/json/shortestpath/:later/:earlier',function(req,res,next) {
  var later = req.params.later;
  var earlier = req.params.earlier;
  //txs[n] = all nth generation ancestors of `later`
  //txs[n][h] = descendant of transaction with hash h, if it is an nth generation ancestor
  var txs = [{}];
  txs[0][later] = null;
  var newtxs = {};
  var cbcount = txs.length;
  var nextdone = false;
  //Optional support for including the block of each transaction in the spentdb, optimizes code
  //Gracefully degrades if such info is absent
  var minblock = 0; 
  db.open(function(err, db) {
    db.collection('spentdb',function(err,collection) {
      collection.find({txhash:earlier}).toArray(function(err, results) {
        if (results.length != 0 && results[0].block) {
          minblock = results[0].block;
        }
        next(0);
      });
    });
    function next(depth) {
      newtxs = {};
      cbcount = 0;
      for (var txhash in txs[depth]) {
        cbcount++;
        if (nextdone) break;
        db.collection('spentdb',function(err,collection) {
          collection.find({txhash:txhash}).toArray(function(err, results) {
            if (results.length == 0) {
              last(null,0); //Search over, return failure
              return;
            }
            if (!results[0].block || results[0].block >= minblock) {
              newtxs[results[0].prev_txhash] = results[0].txhash;
            }
            if (results[0].prev_txhash === earlier) {
              //Found `earlier` as ancestors of later!
              txs.push(newtxs);
              last(results[0].prev_txhash,depth+1);
              return;
            }
            cbcount --;
            txs.push(newtxs);
            if (cbcount === 0) { next(depth + 1); } //All callbacks complete, move to ancestors of generation depth+1
          });
        });
      }
    }
    function last(tx,depth) {
      if (!tx) { res.write("Path not found"); }
      else {
        o = [];
        for (;depth >= 0; depth -= 1) {
          o.push(tx);
          tx = txs[depth][tx];
        }
        res.write(JSON.stringify(o));
      }
      db.close();
      res.end();
    }
  });
});

var rpcClient = new RpcClient(config.jsonrpc.port, config.jsonrpc.host,
                              config.jsonrpc.username, config.jsonrpc.password);

var rpc = rpcClient.connectSocket();

rpc.on('connect', function () {
  var moduleSrc = fs.readFileSync(__dirname + '/query.js', 'utf8');
  rpc.call('definerpcmodule', ['explorer', moduleSrc], function (err) {
    if (err) {
      console.error('Error registering query module: '+err.toString());
    }

    var arguments = process.argv.splice(2);

    switch(arguments[0]){
      case 'create':
        console.log('starting to build spending db')
        console.log(arguments);
        //var genesis = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'  
        var genesis = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943' //Testnet
        db.open(function(err, db) {
	    db.collection('spentdb', function (err, collection){
		if (err) return console.log(err);
		collection.ensureIndex({prev_txhash: 1, prev_out_index:1});
		collection.ensureIndex({prev_txhash: 1});
	    });

          db.collection('lastpared', function(err, collection) {
            collection.find({name:'lastHash'}).toArray(function(err, results) {
              if (err) return console.log(err);
              //db.close()
              if (results[0])
                everParseBlock(results[0].hash)
              else
                everParseBlock(genesis)
            });
          })
        })
        break;
      case 'dcoinbase':
        console.log('starting to build spending db')
        console.log(arguments);
        //var genesis = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'  
        var genesis = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943' //Testnet
        db.open(function(err, db) { //TODO: indices
          db.collection('lastpared', function(err, collection) {
            collection.find({name:'lastDCHash'}).toArray(function(err, results) {
              if (err) return console.log(err);
              //db.close()
              if (results[0])
                everParseDCoinbase(results[0].hash)
              else
                everParseDCoinbase(genesis)
            });
          })
        })
        break;
      case 'drop':
        dropCollection()
        break
      default:
        console.log('if you want to delete or create the index db than run')
        console.log('drop: node app.js drop')
        console.log('create: node app.js create')
        if (!module.parent) {
          app.listen(3334);
          console.info("Express server listening on port " + 3334);
        }
    }
  });
});

function dropCollection (argument) {
  db.open(function(err, db) {
    db.collection('dtocoinbase',function(err, collection) {
      collection.remove({}, function(err,result) {
        if (err) return console.log(err);
        console.log('COLLECTION REMOVED dtocoinbase');
        db.collection('spentdb',function(err, collection) {
          collection.remove({}, function(err, result) {
            if (err) return console.log(err);
            console.log('COLLECTION REMOVED spentdb');
            db.collection('lastpared',function(err, collection) {
              collection.remove({}, function(err, result) {
                if (err) return console.log(err);
                console.log('COLLECTION REMOVED lastpared');
                db.close()
                process.kill();
              })
            })
          })
        })
      })
    })
  });
}

function everParseDCoinbase(blockHash){
    var cbs, b;
    var block_txs = {};
    //Get block
    var hash = Util.decodeHex(blockHash).reverse();
    var hash64 = hash.toString('base64');
    rpc.call('explorer.blockquery', [hash64], parseBlock);
    //Get block txs
    function parseBlock (err, block) {
      if (err) return console.log(err);
      b = block
      console.log('grabbed block: '+block.block.height+' hash: '+block.block.hash+' txs count:'+block.txs.length)
      cbs = block.txs.length;
      block_txs = {};
      block.txs.forEach(function (tx) {
        //The order in which the keys appear when going through block_txs in a for
        //loop is the order in which they are inserted. Hence, this ensures that
        //transactions are ultimately processed in the given order, so if they are
        //given in dependency order then the parent resolution loop will complete
        //in exactly two cycles
        for (var o = 0; o < tx.out.length; o++) {
          block_txs[o+" "+tx.hash] = {dist: 99999999, pnts: []};
        }
        //hash = Util.decodeHex(tx.hash).reverse();
        //var hash64 = hash.toString('base64');
	  try {
        getCollection(null, tx);
	  }
	  catch (err) {
	      console.log(err);
	  }

        //rpc.call('explorer.txquery', [hash64], getCollection)
      })
    }
    //Populate the block_txs array with objects of the form
    //(oindex + " " + txhash):
    //       {dist: (dist to coinbase or 99999999), 
    //        pnts: (all parents of transaction),
    //         pnt: (closest parent to coinbase if found)}
    //It may not always be possible to fully fill the table
    //if a tx's parents are in the same block, so some
    //transactions will have pnt=null, dist=99999999
    function getCollection (err,tx) {
      if (err) return console.log(err);
      db.collection('dtocoinbase', function (err, collection){
        if (err) return console.log(err);
          var innerercbs = tx.in.length;
          var bkMatching = bkMatchInputs(tx);
          for (var ind = 0; ind < tx.in.length; ind++) {
            var input = tx.in[ind];
            for (var j = 0; j < bkMatching[ind].length; j++) {
              block_txs[bkMatching[ind][j]+" "+tx.hash].pnts.push(input.prev_out.n+" "+input.prev_out.hash);
            }
            //The weird double-wrapped function is a closure to pass ind into the callback (as i)
            collection.find({txhash:input.prev_out.hash,oindex:input.prev_out.n}).toArray(function(i) { return function(err, results) {
              if (err) return console.log(err);
              for (var j = 0; j < bkMatching[i].length; j++) {
                var oIndex = bkMatching[i][j];
                console.log(oIndex+" "+tx.hash+" "+tx.out.length);
                if (results.length > 0) {
                  if (results[0].dtocoinbase + 1 < block_txs[oIndex+" "+tx.hash].dist) {
                    block_txs[oIndex+" "+tx.hash].dist = results[0].dtocoinbase + 1;
                    block_txs[oIndex+" "+tx.hash].pnt = results[0].oindex+" "+results[0].txhash;
                  }
                }
                if (input.prev_out.hash == "0000000000000000000000000000000000000000000000000000000000000000") {
                    block_txs[oIndex+" "+tx.hash].dist = 0;
                    block_txs[oIndex+" "+tx.hash].pnt = "";
                }
              } 
              innerercbs--;
              if (innerercbs == 0) {
                cbs --;
                // All callbacks complete, move on to next step
                if (cbs == 0) populateDb(collection);
              }
            };}(ind));
          }
      })
    }
    //Fill in all remaining parents and distances
    //Runtime is O(n^2) over length-n chains in a single block, 
    //but the constant factor is Javascript operations and not
    //database accesses, so it appears fast enough in practice,
    //as such pathological cases are rare
    function populateDb(collection) {
      console.log('POPULATING DB');
      for (var k in block_txs) console.log(k);
      while (1) {
        var done = true;
        for (var k in block_txs) {
          for (var i = 0; i < block_txs[k].pnts.length; i++) {
            var p = block_txs[k].pnts[i];
            if (block_txs[p] && block_txs[p].dist + 1 < block_txs[k].dist) {
              block_txs[k].dist = block_txs[p].dist + 1;
              block_txs[k].pnt = p;
              console.log('NQP: '+k); //Print txs with parents in the same block out of curiosity
              done = false;
            }
          }
        }
        if (done) break;
        else console.log('NOT QUITE POPULATED');
      }
      console.log('POPULATED');
      var toinsert = 0;
      for (var k in block_txs) { toinsert++; }
      for (var k in block_txs) {
        var rec =
          { dtocoinbase : block_txs[k].dist
          , closestParent : {txhash: block_txs[k].pnt.split(' ')[1],
                             oindex: block_txs[k].pnt.split(' ')[0]}
          , txhash : k.split(' ')[1]
          , oindex : parseInt(k.split(' ')[0])
          , block : b.block.height
          }
        if (rec.dtocoinbase === 99999999) {
          return console.log('ERROR Transaction found in blockchain with no parent. Txhash: '+k);
        }
        collection.insert(rec,function(err) {
          if (err) return console.log(err);
          toinsert--;
          if (toinsert == 0) parseNextBlock();
        })
      }
    }
    function parseNextBlock (){
      var block = b
      if (block.nextBlock) {
          db.collection('lastpared', function(err, collection) {
            collection.update(
                {name:'lastDCHash'}
                , {name:'lastDCHash',hash:block.nextBlock.hash}
                , {upsert:true}
                , function(err, ress){
                    if (err) return console.log(err);
                    everParseDCoinbase(block.nextBlock.hash)
                  }
            );
          })
      } else {
        db.close()
        console.log('finished');
      }
    }
}
function everParseBlock(blockHash){
  Step(
    function getBlock() {
      var hash = Util.decodeHex(blockHash).reverse();
      var hash64 = hash.toString('base64');
      rpc.call('explorer.blockquery', [hash64], this)
    },
    function getCollection (err, block){
      if (err) return console.log(err);
      this.b = block;
      var txs = block.txs;
      console.log('grabbed block: '+block.block.height+' hash: '+block.block.hash+' txs count:'+block.txs.length)
      var parallel = this.parallel;
      db.collection('spentdb', function (err, collection){
        if (err) return console.log(err);
        txs.forEach(function(tx){
          for (var i = 0; i < tx.in.length; i++) {
	      var inp = tx.in[i];
              if (inp.type == 'coinbase') break;
              var rec =
		  { prev_txhash : inp.prev_out.hash
		    , prev_out_index : inp.prev_out.n
		    , txhash : tx.hash
		  };
              collection.update(
                  { prev_txhash : inp.prev_out.hash
                    , prev_out_index : inp.prev_out.n
                  }
                  , rec
                  , {upsert:true}
                  , parallel()
              );
          };
        })
      })
      return 1;
    },
    function parseNextBlock (err){
      var block = this.b;
      this.b = null;
      if (block.nextBlock) {
          db.collection('lastpared', function(err, collection) {
            collection.update(
                {name:'lastHash'}
                , {name:'lastHash',hash:block.nextBlock.hash}
                , {upsert:true}
                , function(err, ress){
                    if (err) return console.log(err);
                    everParseBlock(block.nextBlock.hash)
                  }
            );
          })
      } else {
        db.close()
        console.log('finished');
      }
    }
  );
}

/*if (!module.parent) {
  app.listen(3000);
  winston.info("Express server listening on port " + 3000);
}*/


