const express = require('express');
const personalBookmarksRouter = express.Router({mergeParams: true});
const Keycloak = require('keycloak-connect');
const Token = require('keycloak-connect/middleware/auth-utils/token');

const Bookmark = require('../../models/bookmark');
const User = require('../../models/user');
const bookmarkHelper = require('../../common/bookmark-helper');
const bookmarksSearchService = require('../../common/bookmarks-search.service');
const MyError = require('../../models/error');
const escapeStringRegexp = require('escape-string-regexp');

const common = require('../../common/config');
const config = common.config();

const constants = require('../../common/constants');

const HttpStatus = require('http-status-codes');

//showdown converter - https://github.com/showdownjs/showdown
const showdown = require('showdown'),
  converter = new showdown.Converter();

//add keycloak middleware
const keycloak = new Keycloak({scope: 'openid'}, config.keycloak);
personalBookmarksRouter.use(keycloak.middleware());

/**
 * CREATE bookmark for user
 */
personalBookmarksRouter.post('/', keycloak.protect(), async (request, response) => {

  let userId = request.kauth.grant.access_token.content.sub;
  if ( userId !== request.params.userId ) {
    return response
      .status(HttpStatus.UNAUTHORIZED)
      .send(new MyError('Unauthorized', ['the userId does not match the subject in the access token']));
  }

  const bookmark = bookmarkHelper.buildBookmarkFromRequest(request);

  if ( bookmark.userId !== userId ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('The userId of the bookmark does not match the userId parameter', ['The userId of the bookmark does not match the userId parameter']));
  }

  const missingRequiredAttributes = !bookmark.name || !bookmark.location || !bookmark.tags || bookmark.tags.length === 0;
  if ( missingRequiredAttributes ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Missing required attributes', ['Missing required attributes']));
  }
  if ( bookmark.tags.length > constants.MAX_NUMBER_OF_TAGS ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Too many tags have been submitted', ['Too many tags have been submitted']));
  }

  let blockedTags = '';
  for ( let i = 0; i < bookmark.tags.length; i++ ) {
    const tag = bookmark.tags[i];
    if ( tag.startsWith('awesome') ) {
      blockedTags = blockedTags.concat(' ' + tag);
    }
  }

  if ( blockedTags ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('The following tags are blocked:' + blockedTags, ['The following tags are blocked:' + blockedTags]));
  }

  if ( bookmark.description ) {
    const descriptionIsTooLong = bookmark.description.length > constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION;
    if ( descriptionIsTooLong ) {
      return response
        .status(HttpStatus.BAD_REQUEST)
        .send(new MyError('The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed',
          ['The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed']));
    }

    const descriptionHasTooManyLines = bookmark.description.split('\n').length > constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION;
    if ( descriptionHasTooManyLines ) {
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
    }).lean().exec();
    if ( existingBookmark ) {
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
    if ( duplicateKeyinMongoDb ) {
      return response
        .status(HttpStatus.CONFLICT)
        .send(new MyError('Duplicate key', [err.message]));
    }
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(err);
  }

});

/* GET bookmark of user */
personalBookmarksRouter.get('/', keycloak.protect(), async (request, response) => {

  const userId = request.kauth.grant.access_token.content.sub;
  if ( userId !== request.params.userId ) {
    return response
      .status(HttpStatus.UNAUTHORIZED)
      .send(new MyError('Unauthorized', ['the userId does not match the subject in the access token']));
  }

  try {
    const searchText = request.query.q;
    const limit = parseInt(request.query.limit);

    if ( searchText ) {
      const bookmarks = await bookmarksSearchService.findBookmarks(searchText, limit, constants.DOMAIN_PERSONAL, userId);

      return response.send(bookmarks);
    } else if ( request.query.location ) {
      const bookmark = await Bookmark.findOne({
        userId: request.params.userId,
        location: request.query.location
      }).lean().exec();
      if ( !bookmark ) {
        return response.status(HttpStatus.NOT_FOUND).send("Bookmark not found");
      }
      return response.send(bookmark);
    } else {//no filter - latest bookmarks added to the platform
      bookmarks = await Bookmark.find({userId: request.params.userId})
        .sort({lastAccessedAt: -1})
        .limit(100);

      return response.send(bookmarks);
    }
  } catch (err) {
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
  }
});

/* GET tags used by user */
personalBookmarksRouter.get('/tags', keycloak.protect(), async (request, response) => {

  const userId = request.kauth.grant.access_token.content.sub;
  if ( userId !== request.params.userId ) {
    return response
      .status(HttpStatus.UNAUTHORIZED)
      .send(new MyError('Unauthorized', ['the userId does not match the subject in the access token']));
  }

  try {
    const tags = await Bookmark.distinct("tags",
      {
        $or: [
          {userId: request.params.userId},
          {shared: true}
        ]
      }); // sort does not work with distinct in mongoose - https://mongoosejs.com/docs/api.html#query_Query-sort

    response.send(tags);
  } catch (err) {
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
  }
});


/* GET bookmark of user */
personalBookmarksRouter.get('/:bookmarkId', keycloak.protect(), async (request, response) => {

  const userId = request.kauth.grant.access_token.content.sub;
  if ( userId !== request.params.userId ) {
    return response
      .status(HttpStatus.UNAUTHORIZED)
      .send(new MyError('Unauthorized', ['the userId does not match the subject in the access token']));
  }

  try {
    const bookmark = await Bookmark.findOne({
      _id: request.params.bookmarkId,
      userId: request.params.userId
    });

    if ( !bookmark ) {
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
 * full UPDATE via PUT - that is the whole document is required and will be updated
 * the descriptionHtml parameter is only set in backend, if only does not come front-end (might be an API call)
 */
personalBookmarksRouter.put('/:bookmarkId', keycloak.protect(), async (request, response) => {
  let userId = request.kauth.grant.access_token.content.sub;
  const token = new Token(request.kauth.grant.access_token.token, 'bookmarks-api');
  const isNotAdmin = !token.hasRealmRole('ROLE_ADMIN');
  if(isNotAdmin) {
    if ( userId !== request.params.userId) {
      return response
        .status(HttpStatus.UNAUTHORIZED)
        .send(new MyError('Unauthorized', ['the userId does not match the subject in the access token']));
    }

    if ( request.body.userId !== userId ) {
      return response
        .status(HttpStatus.BAD_REQUEST)
        .send(new MyError('The userId of the bookmark does not match the userId parameter', ['The userId of the bookmark does not match the userId parameter']));
    }
  }

  const requiredAttributesMissing = !request.body.name || !request.body.location || !request.body.tags || request.body.tags.length === 0;
  if ( requiredAttributesMissing ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Missing required attributes', ['Missing required attributes']));
  }

  if ( request.body.tags.length > constants.MAX_NUMBER_OF_TAGS ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('Too many tags have been submitted', ['Too many tags have been submitted']));
  }

  let blockedTags = '';
  for ( let i = 0; i < request.body.tags.length; i++ ) {
    const tag = request.body.tags[i];
    if ( tag.startsWith('awesome') ) {
      blockedTags = blockedTags.concat(' ' + tag);
    }
  }
  if ( blockedTags ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('The following tags are blocked:' + blockedTags, ['The following tags are blocked:' + blockedTags]));
  }

  const descriptionIsTooLong = request.body.description.length > constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION;
  if ( descriptionIsTooLong ) {
    return response
      .status(HttpStatus.BAD_REQUEST)
      .send(new MyError('The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed',
        ['The description is too long. Only ' + constants.MAX_NUMBER_OF_CHARS_FOR_DESCRIPTION + ' allowed']));
  }

  if ( request.body.description ) {
    const descriptionHasTooManyLines = request.body.description.split('\n').length > constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION;
    if ( descriptionHasTooManyLines ) {
      return response
        .status(HttpStatus.BAD_REQUEST)
        .send(new MyError('The description hast too many lines. Only ' + constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION + ' allowed',
          ['The description hast too many lines. Only ' + constants.MAX_NUMBER_OF_LINES_FOR_DESCRIPTION + ' allowed']));
    }
  }
  if ( request.body.shared ) {
    const existingBookmark = await Bookmark.findOne({
      shared: true,
      location: request.body.location,
      userId: {$ne: request.params.userId}
    }).lean().exec();
    if ( existingBookmark ) {
      return response
        .status(HttpStatus.CONFLICT)
        .send(new MyError('A public bookmark with this location is already present',
          ['A public bookmark with this location is already present']));
    }
  }

  if ( !request.body.descriptionHtml ) {
    request.body.descriptionHtml = converter.makeHtml(request.body.description);
  }

  try {
    const bookmark = await Bookmark.findOneAndUpdate(
      {
        _id: request.params.bookmarkId,
        userId: request.params.userId
      },
      request.body,
      {new: true}
    );

    const bookmarkNotFound = !bookmark;
    if ( bookmarkNotFound ) {
      return response
        .status(HttpStatus.NOT_FOUND)
        .send(new MyError('Not Found Error', ['Bookmark for user id ' + request.params.userId + ' and bookmark id ' + request.params.bookmarkId + ' not found']));
    } else {
      response
        .status(200)
        .send(bookmark);
    }
  } catch (err) {
    if ( err.name === 'MongoError' && err.code === 11000 ) {
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
* DELETE bookmark for user
*/
personalBookmarksRouter.delete('/:bookmarkId', keycloak.protect(), async (request, response) => {
  const token = new Token(request.kauth.grant.access_token.token, 'bookmarks-api');
  const isNotAdmin = !token.hasRealmRole('ROLE_ADMIN');
  if(isNotAdmin) {
    const userId = request.kauth.grant.access_token.content.sub;
    if ( userId !== request.params.userId ) {
      return response
        .status(HttpStatus.UNAUTHORIZED)
        .send(new MyError('Unauthorized', ['the userId does not match the subject in the access token']));
    }
  }

  const bookmarkId = request.params.bookmarkId;
  try {
    const bookmark = await Bookmark.findOneAndRemove({
      _id: bookmarkId,
      userId: request.params.userId
    });

    if ( !bookmark ) {
      return response
        .status(HttpStatus.NOT_FOUND)
        .send(new MyError(
          'Not Found Error',
          ['Bookmark for user id ' + request.params.userId + ' and bookmark id ' + bookmarkId + ' not found']
          )
        );
    } else {
      await User.update(
        {},
        {
          $pull: {
            readLater: bookmarkId,
            likes: bookmarkId,
            pinned: bookmarkId,
            history: bookmarkId,
            favorites: bookmarkId
          }
        },
        {multi: true}
      );

      response.status(HttpStatus.NO_CONTENT).send();
    }
  } catch (err) {
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(new MyError('Unknown server error',
        ['Unknown server error when trying to delete bookmark with id ' + bookmarkId]));
  }
});

module.exports = personalBookmarksRouter;
