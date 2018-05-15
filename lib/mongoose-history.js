"use strict";
const mongoose = require('mongoose');
const hm = require('./history-model');
const async = require('async')
const contextService = require('request-context');
const deepDiff = require('./deepDiff/deepDiff');

module.exports = function historyPlugin(schema, options) {
  const customCollectionName  = options && options.customCollectionName;
  const customDiffAlgo = (options && options.customDiffAlgo) || defaultAlgo;
  const diffOnly  = options && options.diffOnly;
  const metadata = options && options.metadata;
  const addUserWhoModifies = options && options.modifiedBy;
  let modifiedBy = null;

  // Clear all history collection from Schema
  schema.statics.historyModel = function() {
    return hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
  };

  // Clear all history documents from history collection
  schema.statics.clearHistory = function(callback) {
    const History = hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
    History.remove({}, function(err) {
      callback(err);
    });
  };

  // Save original data
  schema.post( 'init', function() {
    if (diffOnly){
      this._original = this.toObject();
    }
  });

  function setMetadata(original, d, historyDoc, callback){
    async.each(metadata, (m, cb) => {
      if (typeof(m.value) === 'function'){
        if (m.value.length === 3){
          /** async function */
          m.value(original, d, function(err, data){
            if (err) cb(err);
            historyDoc[m.key] = data;
            cb();
          })
        } else {
          historyDoc[m.key] = m.value(original, d);
          cb();
        }
      } else {
        historyDoc[ m.key] = d ? d[ m.value] : null;
        cb();
      }
    }, callback)
  }


  // Create a copy when insert or update, or a diff log
  schema.pre('save', function(next) {
    let historyDoc = {};

    if(diffOnly && !this.isNew) {
      var original = this._original;
      delete this._original;
      var d = this.toObject();
      var diff = {};
      diff['_id'] = d['_id'];
      for(var k in d) {
        var customDiff = customDiffAlgo(k, d[k], original[k]);
        if(customDiff) {
          diff[k] = customDiff
        }
      }

      historyDoc = createHistoryDoc(diff, 'u');
    } else {
      var d = this.toObject();
      let operation = this.isNew ? 'i' : 'u';
      historyDoc = createHistoryDoc(d, operation);
    }

    saveHistoryModel(original, d, historyDoc, this.collection.name, next);
  });

  // Listen on update
  schema.pre('update', function(next) {
    let d = this._update.$set;
    let historyDoc = createHistoryDoc(d, 'u');

    saveHistoryModel(this.toObject, d, historyDoc, this.mongooseCollection.collectionName, next);
  });

  // Create a copy on remove
  schema.pre('remove', function(next) {
    let d = this.toObject();
    let historyDoc = createHistoryDoc(d, 'r');

    saveHistoryModel(this.toObject(), d, historyDoc, this.collection.name, next);
  });

  if (addUserWhoModifies) {
    //Populate the modifiedBy in the find because it is not working in save
    schema.pre('findOne', function (next) {
      modifiedBy = contextService.get(addUserWhoModifies.contextPath);
      next();
    });
  }

  function createHistoryDoc(d, operation) {
    d.__v = undefined;

    let historyDoc = {};
    historyDoc['t'] = new Date();
    historyDoc['o'] = operation;
    historyDoc['d'] = d;

    if (addUserWhoModifies) {
      let localModifiedBy = contextService.get(addUserWhoModifies.contextPath);
      if (localModifiedBy) {
        historyDoc['modifiedBy'] = localModifiedBy;
      } else {
        historyDoc['modifiedBy'] = modifiedBy;
      }
    }


    return historyDoc;
  } 

  function saveHistoryModel(original, d, historyDoc, collectionName, next) {
    if (metadata) {
      setMetadata(original, d, historyDoc, (err) => {
        if (err) return next(err);
        let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
        history.save(next);
      });
    } else {
      let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
      history.save(next);
    }
  }

  // Need this algorithm by default
  function defaultAlgo(k, d, original) {
    if (k === 'updatedAt') {
      return null;
    }
    if (d instanceof Date && original instanceof Date) {
      if (d.getTime() !== original.getTime()) {
        return d;
      }
    } else if (typeof d === 'object' && typeof original === 'object') {
      return deepDiff(original, d, true);
    } else {
      if (d !== original) {
        return d;
      }
    }
  }

};
