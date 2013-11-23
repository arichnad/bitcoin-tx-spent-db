var txdatacache = {};
var coinbaseHash = '0000000000000000000000000000000000000000000000000000000000000000';


function getTransaction(txHash, callback) {
    var data = txdatacache[txHash];
    if (data)
	callback(data);
    else
    $.ajax({
	url: "/rawtx/" + txHash,
	dataType: "json"
    }).done(function (data) {
	txdatacache[txHash] = data;
	callback(data);
    }).fail(function (what, thefuck) { alert('fail:' + what + ' ' + thefuck);});
}

var txspentcache = {};

function getWhoSpends(txHash, outIndex, callback) {
    var k = outIndex + " " + txHash;
    var data = txspentcache[k];
    if (data) callback(data);
    else
    $.ajax({
	url: "/spends/" + txHash,
	dataType: "json"
    }).done(function (data) {
	txspentcache[k] = data[outIndex];
	callback(data);
    }).fail(function (what, thefuck) { alert('fail:' + what + ' ' + thefuck);});
}

function getSpent(txHash, callback) {
    var k = txHash;
    var data = txspentcache[k];
    if (data) callback(data);
    else
    $.ajax({
	url: "/spends/" + txHash,
	dataType: "json"
    }).done(function (data) {
	txspentcache[k] = data;
	callback(data);
    }).fail(function (what, thefuck) { alert('fail:' + what + ' ' + thefuck);});
}


// move decimal point 8 places
function btcToSatoshi(s) {
    if (typeof s != 'string') return s;
    // find decimal point
    var i = s.indexOf('.');
    if(i !== -1) {
        // parse string without '.' as an integer
        var x = +(s.substr(0, i) + s.substr(i+1, i+9));

        // multiply by power of 10 to make into satoshis
        return x * Math.pow(10, 9 - s.length + i);
    } else {
        return +s * 1e8;
    }
}

// convert the input and output values from BTC to Satoshis
// If not, then floating point rounding errors will propagate
// and cause the matching algorithm to give wrong results
function fixData(tx) {
    tx.out.forEach(function(o) {
        o.value = btcToSatoshi(o.value);
    });

    tx.in.forEach(function(i) {
        i.value = btcToSatoshi(i.prev_out.value);
    });
}

function matchInputs(tx) {
    var inputs = [0];
    var outputs = [];
    var matching = [];

    // create prefix sums
    tx.out.reduce(function(prev, curr) {
        prev += curr.value;            
        outputs.push(prev);
        return prev;
    }, 0);
    tx.in.reduce(function(prev, curr) {            
        prev += curr.value
        inputs.push(prev);
        return prev;
    }, 0);

    // matching algorithm
    var inIdx = 0; var outIdx = 0;
    for(var outIdx = 0; 
        outIdx < outputs.length && inIdx < inputs.length-1; 
        ++outIdx) 
    {
        matching[outIdx] = []      

        for(; inIdx < inputs.length-1; inIdx++) {
            matching[outIdx].push(inIdx);
            if(inputs[inIdx+1] >= outputs[outIdx]) {                
                break;
            }
        }
    }
    
    return matching;
}

function getMatching(txHash, callback) {
    getTransaction(txHash, function(tx) {
        callback(matchInputs(tx));
    });
}

function getColorByDefinition(txHash, outputIdx) {
    // embed some color definitions here for now.
    var defs = [{
        "issues": [{
            "outindex": 0, 
            "txhash": "b1586cd10b32f78795b86e9a3febe58dcb59189175fad884a7f4a6623b77486e"
        }], 
        "style": "genesis", 
        "name": "Blue", 
        "unit": 1, 
        "colorid": "8ec9668e393f2b7682daa2fd40eeee873c07c9ed"
    },{
        "metaprops": [
            "name", 
            "unit"
        ], 
        "metahash": "776d7100a4e22ca75d038d4e533b876f61ecc3a6", 
        "name": "TESTcc", 
        "colorid": "7452b90e22a0b758a048a3db9efa4fd361107350", 
        "style": "genesis", 
        "unit": 1, 
        "issues": [{
                "outindex": 0, 
                "txhash": "c26166c7a387b85eca0adbb86811a9d122a5d96605627ad4125f17f6ddcbf89b"
        }]
    },{
        "issues": [{
            "outindex": 0, 
            "txhash": "8f6c8751f39357cd42af97a67301127d497597ae699ad0670b4f649bd9e39abf"
        }], 
        "style": "genesis", 
        "name": "Red", 
        "unit": 1, 
        "colorid": "f92734dea46ca06107244cc20e44276724846043"
    }];

    // simply compare the given hash and out index with those in the 'issues'
    // field of each color definition. Return the 'name' field if we get a match.
    for(var i = 0; i < defs.length; ++i) {
        var issues = defs[i].issues[0];

        if(issues.txhash === txHash && issues.outindex === outputIdx) {
            return defs[i].name;
        }
    }

    // if we've got here, then none of the definitions matched
    return 'Unknown';
}

function getColor(txHash, outputIdx, callback) {

   function Helper(hash, idx, cb) {
        this.color = 'Unknown';

        // put initial transaction output in queue
        this.queue = [{
            txHash: hash,
            index: idx
        }];

        this.callback = cb;


        this.getColorHelper = function() {
            if(this.queue.length === 0) {
                // we've visited everything and not found a conflict!
                this.callback(this.color);
                return;
            }

            var currentOutput = this.queue.pop();
            var currentHash = currentOutput['txHash'];
            var currentOutIdx = currentOutput['index'];


            // is the current input colored by definition?
            var color = getColorByDefinition(currentHash, currentOutIdx);
            if(color !== 'Unknown') {
                // if we've already got a provisional color
                if(this.color !== 'Unknown') {
                    // make sure the new color matches
                    if(this.color !== color) {
                        this.callback('None');
                    } else {
                        // it matches, keep searching
                        this.getColorHelper();
                    }
                } else {
                    // otherwise, this becomes the provisional color
                    this.color = color;

                    // and carry on with next iteration of loop
                    this.getColorHelper();
                }
            }

            // otherwise, get the transaction, and add
            // the matching inputs to the queue
            else {
                getTransaction(currentHash, function(tx) {
                    // is it coinbase, then we can't go any deeper, so it isn't colored
                    if(tx.in[0].prev_out.hash === coinbaseHash) {
                        this.callback('None');
                    }

                    else {
                        // fix the in and out values to be integers rather than decimals
                        fixData(tx);

                        var matching = matchInputs(tx);


                        // add the matching inputs to the queue
                        matching[currentOutIdx].reverse().forEach(function(inIdx) {
                            var input = tx.in[inIdx];

                            this.queue.push({
                                txHash: input.prev_out.hash,
                                index: input.prev_out.n
                            });
                        }.bind(this));

                        // next round in 'loop'
                        this.getColorHelper();
                    }
                }.bind(this));
            }
        };

        // start traversing
        this.getColorHelper();
    };


    var helper = new Helper(txHash, outputIdx, callback);
}


function test(i, callback) {
    var testVectors = [
        {
            txHash: '3a60b70d425405f3e45f9ed93c30ca62b2a97e692f305836af38a524997dd01d',
            outputIdx: 0,
            color: 'None'
        },{
            txHash: 'c1d8d2fb75da30b7b61e109e70599c0187906e7610fe6b12c58eecc3062d1da5',
            outputIdx: 0,
            color: 'Red'
        },{
            txHash: '8f6c8751f39357cd42af97a67301127d497597ae699ad0670b4f649bd9e39abf',
            outputIdx: 0,
            color: 'Red'
        },{
            txHash: 'f50f29906ce306be3fc06df74cc6a4ee151053c2621af8f449b9f62d86cf0647',
            outputIdx: 0,
            color: 'Blue'
        },{
            txHash: '7e40d2f414558be60481cbb976e78f2589bc6a9f04f38836c18ed3d10510dce5',
            outputIdx: 0,
            color: 'Blue'
        },{
            txHash: '4b60bb49734d6e26d798d685f76a409a5360aeddfddcb48102a7c7ec07243498',
            outputIdx: 0,
            color: 'Red'
        },{
            txHash: '342f119db7f9989f594d0f27e37bb5d652a3093f170de928b9ab7eed410f0bd1',
            outputIdx: 0,
            color: 'None'
        },{
            txHash: 'bd34141daf5138f62723009666b013e2682ac75a4264f088e75dbd6083fa2dba',
            outputIdx: 0,
            color: 'Blue'
        },{
            txHash: 'bd34141daf5138f62723009666b013e2682ac75a4264f088e75dbd6083fa2dba',
            outputIdx: 1,
            color: 'None'
        },{
            txHash: '36af9510f65204ec5532ee62d3785584dc42a964013f4d40cfb8b94d27b30aa1',
            outputIdx: 0,
            color: 'Red'
        },{
            txHash: '741a53bf925510b67dc0d69f33eb2ad92e0a284a3172d4e82e2a145707935b3e',
            outputIdx: 0,
            color: 'Red'
        },{
            txHash: '741a53bf925510b67dc0d69f33eb2ad92e0a284a3172d4e82e2a145707935b3e',
            outputIdx: 1,
            color: 'Red'
        }
    ];

    var test = testVectors[i];

    getColor(test.txHash, test.outputIdx, function(color) {
        console.log(i, color, test.color);
        callback();
    });
}

function testAll() {
    var i = 0;
    testNext();

    function testNext() {
        if(i === 12) return;

        test(i++, function() {
            testNext(i);
        });
    }
}

// testAll();

function rendertx(tx, spent) {
    
    if (spent === undefined) {
	return getSpent(tx.hash, function (spent) {
	    rendertx(tx, spent);
	});
    }

    fixData(tx);

    var ospenttx = {};
    spent.forEach(function (o) {
	ospenttx[o[0]] = o[1];
    });
    
    var $box = $('#txbox');
    $box.empty();
    
    var cereal = 0;

    $box.append("<p><strong>Transaction</strong> " + tx.hash + "</p>");

    $box.append("<p><strong>Inputs:</strong></p>");

    tx.in.forEach(function(i) {
	var spanid = "col" + cereal; cereal ++;

	$p = $("<p>value: " + i.value + ", color: <span id='" + spanid + "'>?</span> </p>");

	if (i.prev_out.hash != coinbaseHash) {
	    $a = $("<a href='#'>" + i.prev_out.hash + " " + i.prev_out.n + "</a>");
	    (function (txhash) {
		$a.click(function () { gotx(txhash); });
	    })(i.prev_out.hash);
	    $t = $("<small>Prev: </small>")
	    $t.append($a);
	    $p.append($t);
	}
	else $p.append("<small>Coinbase</small>");

	$box.append($p);

	if (i.prev_out.hash != coinbaseHash)
	    (function (spanid) {
	     getColor(i.prev_out.hash, i.prev_out.n, function (color) {
		 $("#" + spanid).text(color);
	     });
	    })(spanid);
	else
	    $("#" + spanid).text('None');

    });

    $box.append("<p><strong>Outputs:</strong></p>");

    tx.out.forEach(function(o, oi) {
	var spanid = "col" + cereal; cereal ++;

	$p = $("<p>value: " + o.value + ", color: <span id='" + spanid + "'>?</span>   </p>");
	if (ospenttx[oi]) {
	    var txhash = ospenttx[oi];
	    $a = $("<a href='#'>" + txhash + "</a>");
	    (function (txhash) {
		$a.click(function () { gotx(txhash); });
	    })(txhash);
	    $t = $("<small>Spent: </small>")
	    $t.append($a);
	    $p.append($t);
	}
	else $p.append("<small>Unspent</small>");

	$box.append($p);
	(function (spanid) {
	    getColor(tx.hash, oi, function (color) {
		$("#" + spanid).text(color);
	    });
	})(spanid);
    });
}

