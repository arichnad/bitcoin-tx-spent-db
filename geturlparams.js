//http://stackoverflow.com/questions/520611/how-can-i-match-multiple-occurrences-with-a-regex-in-javascript-similar-to-phps
function getUrlParams() {
  var re = /(?:\?|&(?:amp;)?)([^=&#]+)(?:=?([^&#]*))/g,
      match, params = {},
      decode = function (s) {return decodeURIComponent(s.replace(/\+/g, " "));};

  var url = document.location.href;

  while (match = re.exec(url)) {
    params[decode(match[1])] = decode(match[2]);
  }
  return params;
}
