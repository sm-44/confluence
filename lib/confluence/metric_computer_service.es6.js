// Copyright 2017 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
'use strict';

require('../web_apis/release_interface_relationship.es6.js');
require('../web_apis/release.es6.js');
require('../web_apis/web_interface.es6.js');
require('./lone_removal.es6.js');
require('./api_count_data.es6.js');
require('./api_count.es6.js');
require('./browser_metric_data.es6.js');
require('./browser_specific.es6.js');
require('./lone_omission.es6.js');
require('./metric_computer.es6.js');

foam.ENUM({
  name: 'MetricComputerType',
  package: 'org.chromium.apis.web',

  requries: [
    'org.chromium.apis.web.LoneRemoval',
    'org.chromium.apis.web.ApiCount',
    'org.chromium.apis.web.BrowserSpecific',
    'org.chromium.apis.web.LoneOmission',
  ],

  properties: [
    {
      class: 'Class',
      name: 'metricComputerCls',
    },
    {
      class: 'String',
      name: 'daoName',
      value: 'browserMetricsDAO',
    },
  ],

  values: [
    {
      name: 'LONE_REMOVAL',
      metricComputerCls: 'org.chromium.apis.web.LoneRemoval',
    },
    {
      name: 'BROWSER_SPECIFIC',
      metricComputerCls: 'org.chromium.apis.web.BrowserSpecific',
    },
    {
      name: 'LONE_OMISSION',
      metricComputerCls: 'org.chromium.apis.web.LoneOmission',
    },
    {
      name: 'API_COUNT',
      metricComputerCls: 'org.chromium.apis.web.ApiCount',
      daoName: 'apiCountDAO',
    },
  ],
});

foam.CLASS({
  name: 'MetricComputerService',
  package: 'org.chromium.apis.web',

  requires: [
    'org.chromium.apis.web.ApiCountData',
    'org.chromium.apis.web.BrowserMetricData',
    'org.chromium.apis.web.generated.CompatData',
    'org.chromium.apis.web.LocalJsonDAO',
    'org.chromium.apis.web.Release',
    'org.chromium.apis.web.ReleaseWebInterfaceJunction',
    'org.chromium.apis.web.WebInterface',
  ],
  imports: ['container'],

  properties: [
    {
      class: 'FObjectProperty',
      of: 'foam.mlang.predicate.Predicate',
      name: 'releasePredicate',
      required: true,
    },
    {
      class: 'foam.dao.DAOProperty',
      name: 'releaseDAO',
      transient: true,
      factory: function() {
        this.validate();
        // Ensure that releases are filtered according to service configuration.
        // This maintains consistency between releases passed in to "compute"
        // and releases available to seen by this service.
        return this.getDAO_(this.Release).where(this.releasePredicate);
      },
    },
    {
      class: 'foam.dao.DAOProperty',
      name: 'webInterfaceDAO',
      transient: true,
      factory: function() {
        return this.getDAO_(this.WebInterface);
      },
    },
    {
      class: 'foam.dao.DAOProperty',
      name: 'releaseWebInterfaceJunctionDAO',
      transient: true,
      factory: function() {
        return this.getDAO_(this.ReleaseWebInterfaceJunction);
      },
    },
    {
      class: 'foam.dao.DAOProperty',
      name: 'compatDAO',
      transient: true,
      factory: function() {
        return this.getDAO_(this.CompatData);
      },
    },
    {
      class: 'foam.dao.DAOProperty',
      name: 'browserMetricsDAO',
      transient: true,
      factory: function() {
        return this.lookup('foam.dao.MDAO').create({
          of: this.BrowserMetricData,
        }, this.container);
      },
    },
    {
      class: 'foam.dao.DAOProperty',
      name: 'apiCountDAO',
      transient: true,
      factory: function() {
        return this.lookup('foam.dao.MDAO').create({
          of: this.BrowserMetricData,
        }, this.container);
      },
    },
    {
      class: 'Function',
      name: 'lookup',
      transient: true,
      factory: function() {
        return foam.lookup;
      },
    },
  ],

  methods: [
    {
      name: 'compute',
      returns: 'Promise',
      code: function(metricComputerType, releases, date) {
        this.onBeforeCompute();

        // Shift releases' context to be within their container, but outside
        // whitelisted-for-deserialization context.
        releases = this.recontextualizeReleases_(releases);

        const metricComputer = metricComputerType.metricComputerCls
            .create(null, this.container);
        const dateObj = new Date(date);
        if (isNaN(dateObj.getTime())) {
          return Promise.reject(new Error('Invalid Date: ' + date));
        }

        // Compute metrics (which output to
        // "{browserMetrics|apiCount}DAO"), then return array of computed
        // metrics.
        return metricComputer.compute(releases, dateObj)
            .then(() => this[metricComputerType.daoName].select())
            .then((arraySink) => arraySink.array);
      },
    },
    function getDAO_(cls) {
      // Load JSON in to ArrayDAO.
      const jsonDAO = this.lookup('org.chromium.apis.web.LocalJsonDAO').create({
        of: cls,
        path: `${__dirname}/../../data/json/${cls.id}.json`,
      }, this.container);
      // Create indexed MDAO for fast queries.
      const dao = this.lookup('foam.dao.MDAO').create({
        of: cls,
      }, this.container);

      // Special indexing for Release <==> WebInterface junctions.
      if (cls === this.ReleaseWebInterfaceJunction) {
        dao.addPropertyIndex(this.ReleaseWebInterfaceJunction.SOURCE_ID);
      }

      // Copy ArrayDAO => MDAO; return MDAO.
      return this.lookup('foam.dao.PromisedDAO').create({
        of: cls,
        promise: new Promise((resolve, reject) => {
          // Note: Use of DAOSink without further synchronization is sound
          // because "dao" is a *synchronous* DAO implementation.
          return jsonDAO.select(this.lookup('foam.dao.DAOSink').create({
            dao,
          }, this.container)).then(() => resolve(dao)).catch(reject);
        }),
      }, this.container);
    },
    function recontextualizeReleases_(releases) {
      return releases.map((release) => release.clone(this.container));
    },
  ],

  listeners: [
    {
      name: 'onBeforeCompute',
      documentation: `Listener run before compute() to bind DAOs to container.`,
      code: function() {
        // Ensure input DAOs are bound to container.
        this.container.releaseDAO = this.releaseDAO;
        this.container.webInterfaceDAO = this.webInterfaceDAO;
        this.container.releaseWebInterfaceJunctionDAO =
            this.releaseWebInterfaceJunctionDAO;
        this.container.compatDAO = this.compatDAO;

        // Bind fresh output DAOs to container.
        this.browserMetricsDAO = this.container.browserMetricsDAO =
            this.lookup('foam.dao.MDAO').create({
              of: this.BrowserMetricData,
            }, this.container);
        this.apiCountDAO = this.container.apiCountDAO =
            this.lookup('foam.dao.MDAO').create({
              of: this.ApiCountData,
            }, this.container);
      },
    },
  ],
});
