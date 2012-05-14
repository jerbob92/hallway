/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

var express = require('express');
var connect = require('connect');
var logger = require('logger').logger("webservice");
var async = require('async');
var authManager = require('authManager');
var syncManager = require('syncManager');
var profileManager = require('profileManager');
var ijod = require('ijod');
var pipeline = require('pipeline');
var dMap = require('dMap');
var acl = require('acl');
var idr = require('idr');

var airbrake;

var locker = express.createServer(
  connect.bodyParser(),
  connect.cookieParser(),
  function(req, res, next) {
    logger.debug("REQUEST %s", req.url);
    return next();
  },
  authManager.provider.oauth(),
  authManager.provider.login(),
  function(req, res, next) {
    if(req.url.indexOf('/auth/') === 0 || req.url.indexOf('/oauth/') === 0 || req.url.indexOf('/static/') === 0 || (req._authsome)) return next();
    if(req.url == '/') return res.redirect('http://dev.singly.com/');
    res.json('missing token',401);
  }
);

// Hosting the js auth api from /static
locker.use(express.static(__dirname + '/../Ops/static'));

// Authentication callbacks
locker.get('/auth/:id/auth/:app', function(req, res) {
  authManager.authIsAuth(req.params.id, req.params.app, req, res);
});

locker.post('/auth/:id/auth/:app', function(req, res) {
  authManager.authIsAuth(req.params.id, req.params.app, req, res);
});

// fallback to use cookie that was set in oauth init stage in authManager
locker.get('/auth/:id/auth', function(req, res) {
  if(!req.cookies || !req.cookies['auth'+req.params.id]) {
    logger.warn('missing cookie for fallback auth',req.params.id);
    return res.send("handshake failed, missing cookie, spilled milk!",500);
  }
  console.error("here",req.cookies['auth'+req.params.id]);
  authManager.authIsAuth(req.params.id, req.cookies['auth'+req.params.id], req, res);
});


// Data access endpoints

// simple util for consistent but flexible binary options
function isTrue(field)
{
  if(!field) return false;
  if(field === true) return true;
  if(field == "true") return true;
  if(field == "1") return true;
  if(field == "yes") return true;
  return false;
}

// CORS headers
locker.all('/', function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "X-Requested-With");
  next();
 });

// return convenient list of all profiles auth'd for this account
locker.get('/services', function(req, res) {
  syncManager.manager.getServices(function(err, services){
    if(err) logger.error("/services failed",err);
    if(!services) return res.json('sorry '+err, 500);
    res.json(services);
  });
});

// return convenient list of all profiles auth'd for this account
locker.get('/delay', function(req, res) {
  var ret = {ms:0, count:0};
  var re = (req.query.match) ? new RegExp(req.query.match) : false;
  Object.keys(pipeline.delayz).forEach(function(base){
    if(re && !base.match(re)) return;
    ret.count++;
    ret.ms += pipeline.delayz[base];
  });
  ret.avg = parseInt(ret.ms / ret.count);
  res.json(ret);
  logger.debug(pipeline.delayz);
});

// return convenient list of all profiles auth'd for this account
locker.get('/profiles', function(req, res) {
  var profiles = req._authsome.profiles;
  if(!profiles) return res.json('no profiles found', 404);
  var ret = {all:[]};
  ret.id = req._authsome.account;
  profiles.forEach(function(item) {
    if(!item.profile || item.profile.indexOf('@') == -1) return; // skip any that don't look right
    ret.all.push(item.profile); // all profiles raw
    var parts = item.profile.split('@');
    ret[parts[1]] = parts[0].toString(); // convenience, top level service->id mapping
  });
  logger.anubis(req);
  // if no expanded, return immediately
  if(!isTrue(req.query.data)) return res.json(ret);
  ret.data = {};
  async.forEach(ret.all, function(pid, cb){
    console.error("getting ",pid);
    profileManager.authGet(pid, function(err, auth){
      if(err || !auth) return cb(err);
      ret.data[pid] = auth.profile;
      cb();
    });
  }, function(err){
    if(err) logger.error("failed to expaind data for /profiles ",err);
    res.json(ret);
  })
});

// return convenient list of all profiles auth'd for this account
locker.post('/profiles/delete', function(req, res) {
  var account = req._authsome.account;
  if(!account) return res.json('no account', 404);
  if(typeof req.body == 'string') try {
    req.body = JSON.parse(req.body);
  } catch (E) {
    logger.error("couldn't parse /profiles/delete body", req.body);
    return res.json(false);
  }
  if(req.body !== true) return res.json(false);

  logger.info("deleting account profiles for "+account,req._authsome.profiles);
  acl.delProfiles(account, function(err){
    if(err) logger.error(err);
    logger.anubis(req);
    res.json(true);
  })
})

// return the profile for a given service
locker.get('/profiles/:serviceName', function(req, res) {
  var service = req.params.serviceName;
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if(item.profile.indexOf(service) > 0) pid = item.profile;
  });
  if(!pid) return res.json('missing profile for '+service, 404);
  var base = dMap.defaults(service, 'self') + ':' + pid + '/self';
  logger.debug('getRange '+base);
  var self;
  ijod.getRange(base, {limit:1}, function(item) { self=item }, function(err) {
    if(!self) return res.json(false, 404);
    if(self.idr && self.data && isTrue(req.query.map)) self.map = dMap.map(self);
    logger.anubis(req);
    return res.json(self);
  });
});

// return convenient list of all profiles auth'd for this account
locker.get('/types/:type', function(req, res) {
  var type = req.params.type;
  if(!req._authsome.profiles) return res.json('no profiles found', 404);
  var profiles = [];
  req._authsome.profiles.forEach(function(item) {
    if(!item.profile || item.profile.indexOf('@') == -1) return; // skip any that don't look right
    profiles.push(item.profile); // all profiles raw
  });
  var bases = dMap.types(type, profiles);
  var ret = [];
  if(bases.length == 0) return res.json(ret);

  var tomap = {"photos":"photo:links/oembed", "news":"link:links/oembed", "photos_feed":"photo:links/oembed", "news_feed":"link:links/oembed"}
  // get the offset/limit for each base
  var options = {}
  options.offset = parseInt(parseInt(req.query['offset'] || 0) / bases.length);
  options.limit = parseInt(parseInt(req.query['limit'] || 20) / bases.length);
  logger.debug("TYPE",type,options,bases);
  var oembeds = [];
  async.forEach(bases, function(base, cb){
    ijod.getRange(base, options, function(item) {
      // given the map flag, try to map any known fields
      if(item && item.idr && item.data && isTrue(req.query.map)) item.map = dMap.map(item);
      // try to dmap an oembed
      item.oembed = (item.map && item.map.oembed) ? item.map.oembed : dMap.get('oembed', item.data, item.idr);
      // handle statuses custom
      if(type == 'statuses' || type == 'statuses_feed')
      {
        var text = (item.map && item.map.text) ? item.map.text : dMap.get('text', item.data, item.idr);
        if(!text) return; // bail if none!
        item.oembed = {type:'text', text:text};
      }
      // any ref based oembeds, expand them
      if(!item.oembed && item.refs) Object.keys(item.refs).forEach(function(key){ if(key.indexOf(tomap[type]) == 0) oembeds.push(item) });
      ret.push(item)
    }, cb)
  }, function(err){
    if(err) logger.error("type fetch error for "+type,err);
    ret.sort(function(a,b){return b.at - a.at});
    logger.anubis(req, {count:ret.length});
    if(oembeds.length == 0) return res.json(ret);
    async.forEachLimit(oembeds, 5, function(entry, cb){
      var id;
      Object.keys(entry.refs).forEach(function(key){ if(key.indexOf(tomap[type]) == 0) id = key; });
      if(!id) return cb();
      ijod.getOne(id, function(err, oembed) {
        if(oembed) entry.oembed = oembed.data;
        cb();
      })
    }, function(){ res.json(ret); });
  });
});

// get apps for an account
locker.get('/apps', function(req, res) {
  var account = req._authsome.account;
  acl.getAppsForAccount(account, function(err, js) {
    if(err) return res.json(err, 500);
    logger.anubis(req);
    res.json(js);
  });
});

// get details for a single app
locker.get('/app/:id', function(req, res) {
  var app = req.params.id;
  acl.getApp(app, function(err, js) {
    if(err) return res.json(err, 500);
    logger.anubis(req);
    res.json(js);
  });
});

// create a new app (primarily for a developer, but could be used for anyone someday)
locker.post('/app', function(req, res) {
  if(typeof req.body == 'string') try {
    req.body = JSON.parse(req.body);
  } catch (E) {
    logger.error("couldn't parse /app body", req.body);
    return res.json("invalid boody :(", 500);
  }
  if(typeof req.body != 'object') return res.json("body is wrong type (diet?)",500);
  // make sure to save who created this!
  req.body.account = req._authsome.account;
  acl.addApp(req.body, function(err, js){
    if(err) return res.json(err, 500);
    logger.anubis(req);
    res.json(js);
  });
});

// delete an app using a post request for old html forms
locker.post('/app/:id', function(req, res, next) {
  var appId = req.params.id;
  if(typeof req.body == 'string') try {
    req.body = JSON.parse(req.body);
  } catch (E) {
    logger.error("couldn't parse /app body", req.body);
    return res.json("invalid boody :(", 500);
  }
  if(typeof req.body != 'object') return res.json("body is wrong type (diet?)",500);
  // check for special delete field
  if ( req.body.method === 'DELETE') {
    acl.deleteApp(appId, function(err) {
      if (err) return res.josn(err, 500);
      logger.anubis(req);
      res.send(200);
    });
  } else {
    next();
  }
});

// update details for a single app
locker.post('/app/:id', function(req, res) {
  var appId = req.params.id;
  if(typeof req.body == 'string') try {
    req.body = JSON.parse(req.body);
  } catch (E) {
    logger.error("couldn't parse /app body", req.body);
    return res.json("invalid boody :(", 500);
  }
  if(typeof req.body != 'object') return res.json("body is wrong type (diet?)",500);
  // load the app
  acl.getApp(appId, function(err, app) {
    if(err) return res.json(err, 500);
    // check to make sure this account owns the app
    if (req._authsome.account === app.notes.account) {
      // make sure to save who created this!
      req.body.account = req._authsome.account;
      acl.updateApp(appId, req.body,  function(err) {
        if (err) return res.json(err, 500);
        logger.anubis(req);
        res.send(200);
      });
    } else {
      res.send(404);
    }
  });
});

// Post out to a service
locker.post('/services/:serviceName/:serviceEndpoint', function(req, res) {
// TODO, add back, doesn't currently work!
//  syncManager.syncNow(req.params.serviceName, req.params.serviceEndpoint, req.body, function() {
    res.json(true);
//  });
});

// Get a set of data from a service + endpoint combo
locker.get('/services/:serviceName/:serviceEndpoint', function(req, res) {
  var service = req.params.serviceName;
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if(item.profile.indexOf(service) > 0) pid = item.profile;
  });
  if(!pid) return res.json('missing profile for '+service, 404);
  // construct the base, get the default type for this endpoint
  var type = req.query['type'] || dMap.defaults(service, req.params.serviceEndpoint);
  var base = type + ':' + pid + '/' + req.params.serviceEndpoint;
  var options = {};
  if(req.query['offset']) options.offset = parseInt(req.query['offset']) || 0;
  options.limit = parseInt(req.query['limit'] || 20);
  var written;
  // write out the return array progressively, pseudo-streaming
  console.error('getRange '+base+' '+JSON.stringify(options));
  ijod.getRange(base, options, function(item) {
    if(!written) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.write('[');
    }
    if(written) res.write(',');
    written = (written) ? written+1 : 1;
    // given the map flag, try to map any known fields
    if(item.idr && item.data && isTrue(req.query.map)) item.map = dMap.map(item);
    res.write(JSON.stringify(item));
  }, function(err) {
    // handling errors here is a bit funky
    if(err) logger.error('error sending results for getRange '+base+':',err);
    if(written) {
      logger.anubis(req, {count:written});
      return res.end(']');
    } else {
      return res.send(404);
    }
  });
});

// Get an individual object (pardon the stupidlication for now)
locker.get('/services/:serviceName/:serviceEndpoint/:id', function(req, res) {
  var service = req.params.serviceName;
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if(item.profile.indexOf(service) > 0) pid = item.profile;
  });
  if(!pid) return res.json('missing profile for '+service, 404);
  // construct the base, get the default type for this endpoint
  var base = dMap.defaults(service, req.params.serviceEndpoint) + ':' + pid + '/' + req.params.serviceEndpoint + '#' + req.params.id;
  logger.debug('getOne '+base);
  ijod.getOne(base, function(err, item) {
    if(err) return res.json(err, 500);
    logger.anubis(req);
    return res.json(item);
  });
});

locker.get("/services/reset", function(req, res) {
  var profiles = req._authsome.profiles;
  var pid;
  if (profiles.length == 0) return res.json("Missing profiles", 404);
  async.forEachSeries(profiles, function(item, cb) {
    profileManager.reset(item.profile, function(err) {
      if (err) return res.send(err, 500);
      var atAt = item.profile.indexOf("@");
      syncManager.flushService(item.profile.substr(atAt + 1), item.profile, cb);
    });
  }, function(err) {
    logger.anubis(req);
    res.send(200);
  });
});


// Return a summary of the endpoints
locker.get('/services/:serviceName', function(req, res) {
  var service = req.params.serviceName;
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if(item.profile.indexOf(service) > 0) pid = item.profile;
  });
  if(!pid) return res.json('missing profile for '+service, 404);
  var ret = {};
  async.forEach(dMap.bases([pid]),function(base, cb){
    var b = idr.parse(base);
    ijod.countBase(base, function(count){
      ret[b.path] = count;
      cb();
    })
  }, function(){
    res.json(ret);    
  });
});

// Get a system-wide id uniquely
locker.get('/id/:id', function(req, res) {
  id = req.params.id || req.url.substr(1);
  logger.debug("fetching "+id);
  ijod.getOne(id, function(err, entry) {
    if (err) logger.warn(err);
    if (!entry) return res.json("not found",404);
    logger.anubis(req);
    res.json(entry);
  });
});

// force a synclet to run, mostly internal dev util
locker.get('/services/:serviceName/:serviceEndpoint/run', function(req, res) {
  var service = req.params.serviceName;
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if(item.profile.indexOf(service) > 0) pid = item.profile;
  });
  if(!pid) return res.json('missing profile for '+service, 404);
  // construct the base, get the default type for this endpoint
  var key = pid + '/' + req.params.serviceEndpoint;
  console.error('run '+key);
  syncManager.manager.syncNow(key, function(err) {
    if(err) return res.json(err, 500);
    return res.json(true);
  });
});

// error handling
locker.error(function(err, req, res, next) {
  if(err.stack) logger.error(err.stack);
  if (airbrake) {
    airbrake.notify(err, function(err, url) {
      if (url) logger.error(url);
    });
  }
  res.json('Something went wrong.', 500);
});


locker.initAirbrake = function(key) {
  airbrake = require('airbrake').createClient(key);
};

exports.startService = function(port, ip, cb) {
  locker.listen(port, ip, function() {
    cb(locker);
  });
};