var transactionCache = {};
var coinbaseHash = '0000000000000000000000000000000000000000000000000000000000000000';
var defs = {};
var transactionSpentCache = {};
var colorSetHash = '';



function loadDefs(names, colorSet) {
    defs = {};
    for(i=0;i<names.length;i++) {
        addDef(names[i], colorSet[i]);
    }
}

function addDef(name, colorDescriptor) {
    [coloringScheme, transactionHash, outputIndex, height] = colorDescriptor.split(':');
    defs[transactionHash] = {'colorDescriptor': colorDescriptor, 'name': name, 'unit': 1};
    $('#colorDescriptors').append("<br />\n"+colorDescriptor);
}

function getColorSetFromServer(colorSetHash, callback) {
    $.ajax({
        url: "/get_color_set/" + colorSetHash,
        dataType: "json"
    }).done(function (data) {
        loadDefs(data.names, data.color_set);
        callback();
    }).fail(function (jqXHR, textStatus, errorThrown) { alert('fail:' + jqXHR + ' ' + textStatus);});
}

function addColorSetToServer(callback) {
    //the server fills in the heights and returns both the color_set and the color_set_hash.
    $.ajax({
        url: "/add_color_set/" + getColorSet() + '/' + getNames(),
        dataType: "json"
    }).done(function (data) {
        colorSetHash = data.color_set_hash;
        loadDefs(data.names, data.color_set);
        callback();
    }).fail(function (jqXHR, textStatus, errorThrown) { alert('fail:' + jqXHR + ' ' + textStatus);});
}

function getTransaction(transactionHash, callback) {
    var data = transactionCache[transactionHash];
    if (data)
        callback(data);
    else
    $.ajax({
        url: "/rawtx/" + transactionHash,
        dataType: "json"
    }).done(function (data) {
        transactionCache[transactionHash] = data;
        callback(data);
    }).fail(function (jqXHR, textStatus, errorThrown) { alert('fail:' + jqXHR + ' ' + textStatus);});
}

function getWhoSpends(transactionHash, outIndex, callback) {
    var k = outIndex + " " + transactionHash;
    var data = transactionSpentCache[k];
    if (data) callback(data);
    else
    $.ajax({
        url: "/spends/" + transactionHash,
        dataType: "json"
    }).done(function (data) {
        transactionSpentCache[k] = data[outIndex];
        callback(data);
    }).fail(function (jqXHR, textStatus, errorThrown) { alert('fail:' + jqXHR + ' ' + textStatus);});
}

function getSpent(transactionHash, callback) {
    var k = transactionHash;
    var data = transactionSpentCache[k];
    if (data) callback(data);
    else
    $.ajax({
        url: "/spends/" + transactionHash,
        dataType: "json"
    }).done(function (data) {
        transactionSpentCache[k] = data;
        callback(data);
    }).fail(function (jqXHR, textStatus, errorThrown) { alert('fail:' + jqXHR + ' ' + textStatus);});
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
function fixData(transaction) {
    transaction.out.forEach(function(o) {
        o.value = btcToSatoshi(o.value);
    });

    transaction.in.forEach(function(i) {
        i.value = btcToSatoshi(i.prev_out.value);
    });
}

function matchInputs(transaction) {
    var inputs = [0];
    var outputs = [];
    var matching = [];

    // create prefix sums
    transaction.out.reduce(function(prev, curr) {
        prev += curr.value;            
        outputs.push(prev);
        return prev;
    }, 0);
    transaction.in.reduce(function(prev, curr) {            
        prev += curr.value
        inputs.push(prev);
        return prev;
    }, 0);

    // matching algorithm
    var inIndex = 0; var outIndex = 0;
    for(var outIndex = 0; 
        outIndex < outputs.length && inIndex < inputs.length-1; 
        ++outIndex) 
    {
        matching[outIndex] = []      

        for(; inIndex < inputs.length-1; inIndex++) {
            matching[outIndex].push(inIndex);
            if(inputs[inIndex+1] >= outputs[outIndex]) {                
                break;
            }
        }
    }
    
    return matching;
}

function getMatching(transactionHash, callback) {
    getTransaction(transactionHash, function(transaction) {
        callback(matchInputs(transaction));
    });
}

function getColorByDefinition(checkTransactionHash, checkOutputIndex) {
    var definition = defs[checkTransactionHash];
    if(definition === undefined) {
        return 'Unknown';
    }
    [coloringScheme, transactionHash, outputIndex, height] = definition.colorDescriptor.split(':');
    if(outputIndex != checkOutputIndex) {
        return 'Unknown';
    }

    return definition.name;
}

function getColor(transactionHash, outputIndex, callback) {

   function Helper(hash, idx, cb) {
        this.color = 'Unknown';

        // put initial transaction output in queue
        this.queue = [{
            transactionHash: hash,
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
            var currentHash = currentOutput.transactionHash;
            var currentOutIndex = currentOutput.index;


            // is the current input colored by definition?
            var color = getColorByDefinition(currentHash, currentOutIndex);
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
                getTransaction(currentHash, function(transaction) {
                    // is it coinbase, then we can't go any deeper, so it isn't colored
                    if(transaction.in[0].prev_out.hash === coinbaseHash) {
                        this.callback('None');
                    }

                    else {
                        // fix the in and out values to be integers rather than decimals
                        fixData(transaction);

                        var matching = matchInputs(transaction);


                        // add the matching inputs to the queue
                        matching[currentOutIndex].reverse().forEach(function(inIndex) {
                            var input = transaction.in[inIndex];

                            this.queue.push({
                                transactionHash: input.prev_out.hash,
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


    var helper = new Helper(transactionHash, outputIndex, callback);
}


function test(i, callback) {
    var testVectors = [
        {
            transactionHash: '3a60b70d425405f3e45f9ed93c30ca62b2a97e692f305836af38a524997dd01d',
            outputIndex: 0,
            color: 'None'
        },{
            transactionHash: 'c1d8d2fb75da30b7b61e109e70599c0187906e7610fe6b12c58eecc3062d1da5',
            outputIndex: 0,
            color: 'Red'
        },{
            transactionHash: '8f6c8751f39357cd42af97a67301127d497597ae699ad0670b4f649bd9e39abf',
            outputIndex: 0,
            color: 'Red'
        },{
            transactionHash: 'f50f29906ce306be3fc06df74cc6a4ee151053c2621af8f449b9f62d86cf0647',
            outputIndex: 0,
            color: 'Blue'
        },{
            transactionHash: '7e40d2f414558be60481cbb976e78f2589bc6a9f04f38836c18ed3d10510dce5',
            outputIndex: 0,
            color: 'Blue'
        },{
            transactionHash: '4b60bb49734d6e26d798d685f76a409a5360aeddfddcb48102a7c7ec07243498',
            outputIndex: 0,
            color: 'Red'
        },{
            transactionHash: '342f119db7f9989f594d0f27e37bb5d652a3093f170de928b9ab7eed410f0bd1',
            outputIndex: 0,
            color: 'None'
        },{
            transactionHash: 'bd34141daf5138f62723009666b013e2682ac75a4264f088e75dbd6083fa2dba',
            outputIndex: 0,
            color: 'Blue'
        },{
            transactionHash: 'bd34141daf5138f62723009666b013e2682ac75a4264f088e75dbd6083fa2dba',
            outputIndex: 1,
            color: 'None'
        },{
            transactionHash: '36af9510f65204ec5532ee62d3785584dc42a964013f4d40cfb8b94d27b30aa1',
            outputIndex: 0,
            color: 'Red'
        },{
            transactionHash: '741a53bf925510b67dc0d69f33eb2ad92e0a284a3172d4e82e2a145707935b3e',
            outputIndex: 0,
            color: 'Red'
        },{
            transactionHash: '741a53bf925510b67dc0d69f33eb2ad92e0a284a3172d4e82e2a145707935b3e',
            outputIndex: 1,
            color: 'Red'
        }
    ];

    var test = testVectors[i];

    getColor(test.transactionHash, test.outputIndex, function(color) {
        console.log(i, color, test.color);
        callback();
    });
}

function testAll() {
    defs = {
        "b1586cd10b32f78795b86e9a3febe58dcb59189175fad884a7f4a6623b77486e": {
            'colorDescriptor': 'obc:b1586cd10b32f78795b86e9a3febe58dcb59189175fad884a7f4a6623b77486e:0:0',
            "name": "Blue",
            "unit": 1
        },
        "c26166c7a387b85eca0adbb86811a9d122a5d96605627ad4125f17f6ddcbf89b" : {
            'colorDescriptor': 'obc:c26166c7a387b85eca0adbb86811a9d122a5d96605627ad4125f17f6ddcbf89b:0:0',
            "name": "TESTcc", 
            "unit": 1
        },
        "8f6c8751f39357cd42af97a67301127d497597ae699ad0670b4f649bd9e39abf" : {
            'colorDescriptor': 'obc:8f6c8751f39357cd42af97a67301127d497597ae699ad0670b4f649bd9e39abf:0:0',
            "name": "Red", 
            "unit": 1
        }
    };
    console.log(getColorSet() + '  /  ' + getNames());
    addColorSetToServer(function () {
        console.log(colorSetHash, '673b13966a0dc47bb71a7e270ec15f7df8addcf0166f492e08ae68c2275324ed');
        console.log(getColorSet() + '  /  ' + getNames());
    });
    getColorSetFromServer('673b13966a0dc47bb71a7e270ec15f7df8addcf0166f492e08ae68c2275324ed', function() {
        console.log(getColorSet() + '  /  ' + getNames());
    });

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

function renderTransaction(transaction, spent) {
    
    if (spent === undefined) {
        return getSpent(transaction.hash, function (spent) {
            renderTransaction(transaction, spent);
        });
    }

    fixData(transaction);

    var outputSpentTransaction = {};
    spent.forEach(function (o) {
        outputSpentTransaction[o[0]] = o[1];
    });
    
    var $box = $('#transactionBox');
    $box.empty();
    
    var cereal = 0;

    $box.append("<p><strong>Transaction</strong> " + transaction.hash + "</p>");

    $box.append("<p><strong>Inputs:</strong></p>");

    transaction.in.forEach(function(i) {
        var spanid = "col" + cereal; cereal ++;

        $p = $("<p>value: " + i.value + ", color: <span id='" + spanid + "'>?</span> </p>");

        if (i.prev_out.hash != coinbaseHash) {
            $a = $("<a href='#'>" + i.prev_out.hash + " " + i.prev_out.n + "</a>");
            (function (transactionHash) {
                $a.click(function () { goTransaction(transactionHash); });
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

    transaction.out.forEach(function(o, oi) {
        var spanid = "col" + cereal; cereal ++;

        $p = $("<p>value: " + o.value + ", color: <span id='" + spanid + "'>?</span>   </p>");
        if (outputSpentTransaction[oi]) {
            var transactionHash = outputSpentTransaction[oi];
            $a = $("<a href='#'>" + transactionHash + "</a>");
            (function (transactionHash) {
                $a.click(function () { goTransaction(transactionHash); });
            })(transactionHash);
            $t = $("<small>Spent: </small>")
            $t.append($a);
            $p.append($t);
        }
        else $p.append("<small>Unspent</small>");

        $box.append($p);
        (function (spanid) {
            getColor(transaction.hash, oi, function (color) {
                $("#" + spanid).text(color);
            });
        })(spanid);
    });
}

function getColorDescriptor(coloringScheme, transactionHash, outputIndex, height) {
    return [coloringScheme, transactionHash, outputIndex, height].join(':');
}

function getColorSet() {
    var result = '';
    for(key in defs) {
        if(result !== '') result += ',';
        result += defs[key].colorDescriptor;
    }
    return result;
}

function getNames() {
    var result = '';
    for(key in defs) {
        if(result !== '') result += ',';
        result += defs[key].name;
    }
    return result;
}

