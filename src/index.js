"use strict";

const Client = require("./client");
const Server = require("./server");
const serializer = require("./transforms/serializer");
const createClient = require("./createClient");
const createServer = require("./createServer");
const Proxy = require("./proxy");
const createProxy = require("./createProxy");

module.exports = {
  createClient,
  createServer,
  Client,
  Server,
  states: require("./states"),
  createSerializer: serializer.createSerializer,
  createDeserializer: serializer.createDeserializer,
  ping: require("./ping"),
  supportedVersions: require("./version").supportedVersions,
  defaultVersion: require("./version").defaultVersion,
  Proxy,
  createProxy,
};
