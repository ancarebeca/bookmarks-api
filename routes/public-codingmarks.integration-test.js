var app = require('../app');
var chai = require('chai');
var request = require('supertest');
var HttpStatus = require('http-status-codes');
var expect = chai.expect;

describe('Public API Tests', function () {

  describe('get latest codingmarks function tests', function () {
    const latestEntriesApiBaseUrl = '/api/public/codingmarks/latest-entries';

    it('should return the latest codingmarks - without query parameters', function (done) {
      request(app)
        .get(latestEntriesApiBaseUrl)
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.OK);
          done();
        });
    });

    it('should return the latest codingmarks - "since" parameter', function (done) {
      let oneMonthBeforeNow = new Date();
      oneMonthBeforeNow.setMonth(oneMonthBeforeNow.getMonth() - 1);
      request(app)
        .get(latestEntriesApiBaseUrl)
        .query({since: oneMonthBeforeNow.getTime()})
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.OK);
          done();
        });
    });

    it('should return the latest codingmarks - "since" and "to" parameter', function (done) {
      let sevenDaysBeforeNow = new Date();
      sevenDaysBeforeNow.setDate(sevenDaysBeforeNow.getDate() - 7);

      let twoDaysBeforeNow = new Date();
      twoDaysBeforeNow.setDate(twoDaysBeforeNow.getDate() - 7);

      request(app)
        .get(latestEntriesApiBaseUrl)
        .query({since: sevenDaysBeforeNow.getTime()})
        .query({to: twoDaysBeforeNow.getTime()})
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.OK);
          done();
        });
    });

    it('should return bad request - invalid "since" and "to" parameter', function (done) {
      let sevenDaysBeforeNow = new Date();
      sevenDaysBeforeNow.setDate(sevenDaysBeforeNow.getDate() - 7);

      let twoDaysBeforeNow = new Date();
      twoDaysBeforeNow.setDate(twoDaysBeforeNow.getDate() - 2);

      request(app)
        .get(latestEntriesApiBaseUrl)
        .query({since: twoDaysBeforeNow.getTime()})
        .query({to: sevenDaysBeforeNow.getTime()})
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.BAD_REQUEST);
          done();
        });
    });
  });

  describe('get public codingmarks root endpoint tests', function () {
    const publicCodingmarksApiBaseUrl = '/api/public/codingmarks';

    it('should return all public codingmarks', function (done) {
      request(app)
        .get(publicCodingmarksApiBaseUrl)
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.OK);
          done();
        });
    });

    it('should find codingmark by location', function (done) {
      request(app)
        .get(publicCodingmarksApiBaseUrl)
        .query({location: 'https://www.bookmarks.dev'})
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.OK);
          done();
        });
    });

    it('should not find codingmark by location', function (done) {
      request(app)
        .get(publicCodingmarksApiBaseUrl)
        .query({location: 'unknown_url'})
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.NOT_FOUND);
          done();
        });
    });

    it('should find codingmarks by tag', function (done) {
      request(app)
        .get(publicCodingmarksApiBaseUrl)
        .query({tag: 'java'})
        .end(function (err, res) {
          expect(res.statusCode).to.equal(HttpStatus.OK);
          done();
        });
    });


  });

});