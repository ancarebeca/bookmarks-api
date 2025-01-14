const express = require('express');
const adminRouter = express.Router();

const Keycloak = require('keycloak-connect');

const Bookmark = require('../../models/bookmark');
const bookmarkHelper = require('../../common/bookmark-helper');
const MyError = require('../../models/error');

const common = require('../../common/config');
const config = common.config();
const constants = require('../../common/constants');

const HttpStatus = require('http-status-codes');

//showdown converter - https://github.com/showdownjs/showdown
const showdown = require('showdown'),
  converter = new showdown.Converter();

//add keycloak middleware
const keycloak = new Keycloak({scope: 'openid'}, config.keycloak);
adminRouter.use(keycloak.middleware());


/* GET all bookmarks */
adminRouter.get('/bookmarks', keycloak.protect('realm:ROLE_ADMIN'), async (request, response) => {
  try {
    let bookmarks;
    let filter = {};
    if(request.query.public === 'true') {
      filter.shared = true;
    }
    if (request.query.location) {
      filter.location = request.query.location;
    }
    if (request.query.userId) {
      filter.userId = request.query.userId;
    }
    bookmarks = await Bookmark.find(filter).sort({createdAt: -1}).lean().exec();

    response.send(bookmarks);
  } catch (err) {
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(err);
  }
});


adminRouter.get('/tags', keycloak.protect('realm:ROLE_ADMIN'), async (request, response) => {
  try {
    const tags = await Bookmark.aggregate(
      [
        {$match: {shared: true}},
        {$project: {"tags": 1}},
        {$unwind: "$tags"},
        {$group: {"_id": "$tags", "count": {"$sum": 1}}},
        {$sort: {count: -1}}
      ]
    );

    response.send(tags);
  } catch (err) {
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(err);
  }
});


/**
 * Returns the bookmarks added recently.
 *
 * The since query parameter is a timestamp which specifies the date since we want to look forward to present time.
 * If this parameter is present it has priority. If it is not present, we might specify the number of days to look back via
 * the query parameter numberOfDays. If not present it defaults to 7 days, last week.
 *
 */
adminRouter.get('/bookmarks/latest-entries', keycloak.protect('realm:ROLE_ADMIN'), async (req, res) => {
  try {
    if (req.query.since) {
      const fromDate = new Date(parseFloat(req.query.since, 0));
      const toDate = req.query.to ? new Date(parseFloat(req.query.to, 0)) : new Date();
      if (fromDate > toDate) {
        return res
          .status(HttpStatus.BAD_REQUEST)
          .send(new MyError('timing query parameters values', ['<Since> param value must be before <to> parameter value']));
      }
      const bookmarks = await Bookmark.find(
        {
          'shared': true,
          createdAt: {
            $gte: fromDate,
            $lte: toDate
          }

        }).sort({createdAt: 'desc'}).lean().exec();

      res.send(bookmarks);
    } else {
      const numberOfDaysToLookBack = req.query.days ? req.query.days : 7;

      const bookmarks = await Bookmark.find(
        {
          'shared': true,
          createdAt: {$gte: new Date((new Date().getTime() - (numberOfDaysToLookBack * 24 * 60 * 60 * 1000)))}
        }).sort({createdAt: 'desc'}).lean().exec();

      res.send(bookmarks);
    }

  } catch (err) {
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
  }
});

/* GET bookmark by id */
adminRouter.get('/bookmarks/:bookmarkId', keycloak.protect(), async (request, response) => {

  try {
    const bookmark = await Bookmark.findOne({
      _id: request.params.bookmarkId
    });

    if (!bookmark) {
      return response
        .status(HttpStatus.NOT_FOUND)
        .send(new MyError(
          'Not Found Error',
          ['Bookmark for user id ' + request.params.userId + ' and bookmark id ' + request.params.bookmarkId + ' not found']
          )
        );
    } else {
      response.status(HttpStatus.OK).send(bookmark);
    }
  } catch (err) {
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(new MyError('Unknown server error',
        ['Unknown server error when trying to delete bookmark with id ' + request.params.bookmarkId]));
  }
});

/**
 * create bookmark
 */
adminRouter.post('/bookmarks', keycloak.protect('realm:ROLE_ADMIN'), async (request, response) => {

  const bookmark = bookmarkHelper.buildBookmarkFromRequest(request);

  const missingRequiredAttributes = !bookmark.userId ||!bookmark.name || !bookmark.location || !bookmark.tags || bookmark.tags.length === 0;
  if (missingRequiredAttributes) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Missing required attributes', ['Missing required attributes']));
  }
  if (bookmark.tags.length > constants.MAX_NUMBER_OF_TAGS) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Too many tags have been submitted', ['Too many tags have been submitted']));
  }

  if (bookmark.description) {
    const descriptionIsTooLong = bookmark.description.length > constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION;
    if (descriptionIsTooLong) {
      return response
        .status(HttpStatus.BAD_REQUEST)
        .send(new MyError('The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed',
          ['The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed']));
    }

    const descriptionHasTooManyLines = bookmark.description.split('\n').length > constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION;
    if (descriptionHasTooManyLines) {
      return response
        .status(HttpStatus.BAD_REQUEST)
        .send(new MyError('The description hast too many lines. Only ' + constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION + ' allowed',
          ['The description hast too many lines. Only ' + constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION + ' allowed']));
    }
  }

  if ( bookmark.shared ) {
    const existingBookmark = await Bookmark.findOne({
      shared: true,
      location: bookmark.location
    });
    if( existingBookmark ) {
      return response
        .status(HttpStatus.CONFLICT)
        .send(new MyError('A public bookmark with this location is already present',
          ['A public bookmark with this location is already present']));
    }
  }

  try {
    let newBookmark = await bookmark.save();

    response
      .set('Location', `${config.basicApiUrl}private/${request.params.userId}/bookmarks/${newBookmark.id}`)
      .status(HttpStatus.CREATED)
      .send({response: 'Bookmark created for userId ' + request.params.userId});

  } catch (err) {
    const duplicateKeyinMongoDb = err.name === 'MongoError' && err.code === 11000;
    if (duplicateKeyinMongoDb) {
      return response
        .status(HttpStatus.CONFLICT)
        .send(new MyError('Duplicate key', [err.message]));
    }
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(err);
  }

});


/**
 * full UPDATE via PUT - that is the whole document is required and will be updated
 * the descriptionHtml parameter is only set in backend, if only does not come front-end (might be an API call)
 */
adminRouter.put('/bookmarks/:bookmarkId', keycloak.protect('realm:ROLE_ADMIN'), async (request, response) => {

  const requiredAttributesMissing = !request.body.userId ||  !request.body.name || !request.body.location || !request.body.tags || request.body.tags.length === 0;
  if (requiredAttributesMissing) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Missing required attributes', ['Missing required attributes']));
  }

  if (request.body.tags.length > constants.MAX_NUMBER_OF_TAGS) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Too many tags have been submitted', ['Too many tags have been submitted']));
  }

  const descriptionIsTooLong = request.body.description.length > constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION;
  if (descriptionIsTooLong) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed',
        ['The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed']));
  }

  if (request.body.description) {
    const descriptionHasTooManyLines = request.body.description.split('\n').length > constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION;
    if (descriptionHasTooManyLines) {
      return response
        .status(HttpStatus.BAD_REQUEST)
        .send(new MyError('The description hast too many lines. Only ' + constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION + ' allowed',
          ['The description hast too many lines. Only ' + constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION + ' allowed']));
    }
  }

  if (!request.body.descriptionHtml) {
    request.body.descriptionHtml = converter.makeHtml(request.body.description);
  }
  try {
    const bookmark = await Bookmark.findOneAndUpdate(
      {
        _id: request.params.bookmarkId
      },
      request.body,
      {new: true}
    );

    const bookmarkNotFound = !bookmark;
    if (bookmarkNotFound) {
      return response
        .status(HttpStatus.NOT_FOUND)
        .send(new MyError('Not Found Error', ['Bookmark with bookmark id ' + request.params.bookmarkId + ' not found']));
    } else {
      response
        .status(200)
        .send(bookmark);
    }
  } catch (err) {
    if (err.name === 'MongoError' && err.code === 11000) {
      return response
        .status(HttpStatus.CONFLICT)
        .send(new MyError('Duplicate key', [err.message]));
    }
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(new MyError('Unknown Server Error', ['Unknown server error when updating bookmark for user id ' + request.params.userId + ' and bookmark id ' + request.params.bookmarkId]));
  }
});

/*
* DELETE bookmark for by bookmarkId
*/
adminRouter.delete('/bookmarks/:bookmarkId', keycloak.protect('realm:ROLE_ADMIN'), async (request, response) => {
  try {
    const bookmark = await Bookmark.findOneAndRemove({
      _id: request.params.bookmarkId,
    });

    if (!bookmark) {
      return response
        .status(HttpStatus.NOT_FOUND)
        .send(new MyError(
          'Not Found Error',
          ['Bookmark for user id ' + request.params.userId + ' and bookmark id ' + request.params.bookmarkId + ' not found']
          )
        );
    } else {
      response.status(HttpStatus.NO_CONTENT).send('Bookmark successfully deleted');
    }
  } catch (err) {
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(new MyError('Unknown server error',
        ['Unknown server error when trying to delete bookmark with id ' + request.params.bookmarkId]));
  }
});

/*
* DELETE bookmarks
* either by providing the location (for example to clean up spam)
* or userId (deletes all bookmarks submitted by the user)
*/
adminRouter.delete('/bookmarks', keycloak.protect('realm:ROLE_ADMIN'), async (request, response) => {
  try {
    let filter = {};
    if (request.query.location) {
      filter.location = request.query.location;
    }
    if (request.query.userId) {
      filter.userId = request.query.userId;
    }
    if(filter === {}){
      return response
        .status(HttpStatus.BAD_REQUEST)
        .send(new MyError('You can either delete bookmarks by location or userId - at least one of them mandatory',
          ['You can either delete bookmarks by location or userId - at least one of them mandatory']));
    }

    const responseDeletion = await Bookmark.deleteMany(filter);
    response.status(HttpStatus.NO_CONTENT).send('Bookmarks successfully deleted');
  } catch (err) {
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(new MyError('Unknown server error',
        ['Unknown server error when trying to delete bookmarks']));
  }
});


module.exports = adminRouter;
