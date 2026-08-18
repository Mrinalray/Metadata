/**
 * TRACE — Metadata Backend
 * -------------------------------------------------------------------------
 * Supports:
 *   • Image metadata
 *   • EXIF
 *   • GPS
 *   • IPTC
 *   • XMP
 *   • Camera information
 *   • Date/time
 *   • Video metadata
 *   • Audio metadata
 *   • MediaInfo
 *   • Remote URL metadata
 *
 * Node.js 18+
 * -------------------------------------------------------------------------
 */

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const app = express();

/* =========================================================================
   CONFIG
   ========================================================================= */

const PORT = process.env.PORT || 4000;

const EXIFTOOL_API_URL =
  'https://exiftools.com/api/v1/extract';

const EXIFTOOL_API_KEY =
  process.env.EXIFTOOL_API_KEY;

if (!EXIFTOOL_API_KEY) {
  console.error(
    'ERROR: EXIFTOOL_API_KEY is missing.'
  );
  process.exit(1);
}

/* =========================================================================
   MIDDLEWARE
   ========================================================================= */

app.use(cors());

app.use(
  express.json({
    limit: '10mb'
  })
);

/* =========================================================================
   MULTER
   ========================================================================= */

const upload = multer({
  dest: os.tmpdir(),

  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

/* =========================================================================
   HEALTH CHECK
   ========================================================================= */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'TRACE Metadata API',
    version: '2.0.0',
    exiftool: Boolean(EXIFTOOL_API_KEY)
  });
});

/* =========================================================================
   EXIFTOOLS API
   ========================================================================= */

/**
 * Send a local file to ExifTools.com.
 *
 * IMPORTANT:
 * ExifTools API expects:
 *
 * multipart/form-data
 * field = "file"
 *
 * NOT:
 *
 * application/octet-stream
 */
async function extractExifToolMetadata(filePath, originalName, mimeType) {

  const fileBuffer = await fs.readFile(filePath);

  /*
   * Node.js 18+ provides FormData and Blob globally.
   */
  const form = new FormData();

  const blob = new Blob(
    [fileBuffer],
    {
      type: mimeType || 'application/octet-stream'
    }
  );

  form.append(
    'file',
    blob,
    originalName || 'uploaded-file'
  );

  const response = await fetch(
    EXIFTOOL_API_URL,
    {
      method: 'POST',

      headers: {
        'X-API-Key': EXIFTOOL_API_KEY
      },

      body: form
    }
  );

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `ExifTools returned invalid JSON (${response.status}): ${responseText.slice(0, 1000)}`
    );
  }

  if (!response.ok) {

    const apiError =
      data?.error ||
      data?.message ||
      responseText;

    throw new Error(
      `ExifTools API error ${response.status}: ${formatError(apiError)}`
    );
  }

  if (data?.success === false) {

    throw new Error(
      `ExifTools extraction failed: ${
        formatError(data.error || data.message || data)
      }`
    );
  }

  return data;
}

/* =========================================================================
   MEDIAINFO
   ========================================================================= */

async function extractMediaInfo(filePath) {

  try {

    const { stdout } =
      await execFileAsync(
        'mediainfo',
        [
          '--Output=JSON',
          filePath
        ]
      );

    if (!stdout) {
      throw new Error(
        'MediaInfo returned an empty response.'
      );
    }

    return JSON.parse(stdout);

  } catch (error) {

    throw new Error(
      `MediaInfo failed: ${error.message}`
    );
  }
}

/* =========================================================================
   ERROR FORMATTER
   ========================================================================= */

function formatError(error) {

  if (error == null) {
    return 'Unknown error';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/* =========================================================================
   FILE TYPE HELPERS
   ========================================================================= */

function isImage(mimeType) {
  return String(mimeType || '')
    .toLowerCase()
    .startsWith('image/');
}

function isVideo(mimeType) {
  return String(mimeType || '')
    .toLowerCase()
    .startsWith('video/');
}

function isAudio(mimeType) {
  return String(mimeType || '')
    .toLowerCase()
    .startsWith('audio/');
}

/* =========================================================================
   FILE METADATA ENDPOINT
   ========================================================================= */

/**
 * POST /api/metadata
 *
 * multipart/form-data
 * field:
 *   file
 */

app.post(
  '/api/metadata',
  upload.single('file'),

  async (req, res) => {

    let tempPath = null;

    try {

      /* ---------------------------------------------------------------
         Check upload
         --------------------------------------------------------------- */

      if (!req.file) {

        return res.status(400).json({
          success: false,
          error: 'No file uploaded. Use multipart field "file".'
        });
      }

      tempPath = req.file.path;

      const originalName =
        req.file.originalname || 'uploaded-file';

      const mimeType =
        req.file.mimetype ||
        'application/octet-stream';

      const fileSize =
        req.file.size || 0;

      /* ---------------------------------------------------------------
         Result object
         --------------------------------------------------------------- */

      const result = {

        success: true,

        file: {
          filename: originalName,
          mimeType: mimeType,
          size: fileSize
        },

        exiftool: null,

        mediainfo: null,

        errors: []
      };

      /* ===============================================================
         EXIFTOOLS
         =============================================================== */

      try {

        result.exiftool =
          await extractExifToolMetadata(
            tempPath,
            originalName,
            mimeType
          );

      } catch (error) {

        console.error(
          'ExifTools error:',
          error
        );

        result.errors.push({
          service: 'exiftool',
          message: formatError(error)
        });
      }

      /* ===============================================================
         MEDIAINFO
         =============================================================== */

      if (
        isVideo(mimeType) ||
        isAudio(mimeType)
      ) {

        try {

          result.mediainfo =
            await extractMediaInfo(
              tempPath
            );

        } catch (error) {

          console.error(
            'MediaInfo error:',
            error
          );

          result.errors.push({
            service: 'mediainfo',
            message: formatError(error)
          });
        }
      }

      /* ---------------------------------------------------------------
         Final response
         --------------------------------------------------------------- */

      res.json(result);

    } catch (error) {

      console.error(
        'Metadata endpoint error:',
        error
      );

      res.status(500).json({
        success: false,
        error: formatError(error)
      });

    } finally {

      /* ---------------------------------------------------------------
         Remove temporary file
         --------------------------------------------------------------- */

      if (tempPath) {

        await fs
          .unlink(tempPath)
          .catch(() => {});
      }
    }
  }
);

/* =========================================================================
   URL METADATA ENDPOINT
   ========================================================================= */

/**
 * POST /api/metadata-url
 *
 * Body:
 *
 * {
 *   "url": "https://example.com/image.jpg"
 * }
 */

app.post(
  '/api/metadata-url',

  async (req, res) => {

    let tempPath = null;

    try {

      const { url } =
        req.body || {};

      /* ---------------------------------------------------------------
         Check URL
         --------------------------------------------------------------- */

      if (!url) {

        return res.status(400).json({
          success: false,
          error: 'URL is required.'
        });
      }

      /* ---------------------------------------------------------------
         Validate URL
         --------------------------------------------------------------- */

      let parsedUrl;

      try {

        parsedUrl =
          new URL(url);

      } catch {

        return res.status(400).json({
          success: false,
          error: 'Invalid URL.'
        });
      }

      if (
        parsedUrl.protocol !== 'http:' &&
        parsedUrl.protocol !== 'https:'
      ) {

        return res.status(400).json({
          success: false,
          error:
            'Only HTTP and HTTPS URLs are allowed.'
        });
      }

      /* ---------------------------------------------------------------
         Download remote file
         --------------------------------------------------------------- */

      const response =
        await fetch(
          url,
          {
            redirect: 'follow'
          }
        );

      if (!response.ok) {

        throw new Error(
          `Unable to download URL. HTTP ${response.status}`
        );
      }

      const mimeType =
        response.headers.get(
          'content-type'
        ) ||
        'application/octet-stream';

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      /* ---------------------------------------------------------------
         Create temporary file
         --------------------------------------------------------------- */

      tempPath =
        path.join(
          os.tmpdir(),
          crypto.randomUUID()
        );

      await fs.writeFile(
        tempPath,
        buffer
      );

      /* ---------------------------------------------------------------
         Filename
         --------------------------------------------------------------- */

      let originalName =
        path.basename(
          parsedUrl.pathname
        );

      if (
        !originalName ||
        originalName === '/'
      ) {
        originalName = 'remote-file';
      }

      /* ---------------------------------------------------------------
         Result
         --------------------------------------------------------------- */

      const result = {

        success: true,

        file: {
          filename: url,
          mimeType: mimeType,
          size: buffer.length
        },

        exiftool: null,

        mediainfo: null,

        errors: []
      };

      /* ===============================================================
         EXIFTOOLS
         =============================================================== */

      try {

        result.exiftool =
          await extractExifToolMetadata(
            tempPath,
            originalName,
            mimeType
          );

      } catch (error) {

        console.error(
          'ExifTools URL error:',
          error
        );

        result.errors.push({
          service: 'exiftool',
          message: formatError(error)
        });
      }

      /* ===============================================================
         MEDIAINFO
         =============================================================== */

      if (
        isVideo(mimeType) ||
        isAudio(mimeType)
      ) {

        try {

          result.mediainfo =
            await extractMediaInfo(
              tempPath
            );

        } catch (error) {

          console.error(
            'MediaInfo URL error:',
            error
          );

          result.errors.push({
            service: 'mediainfo',
            message: formatError(error)
          });
        }
      }

      /* ---------------------------------------------------------------
         Send result
         --------------------------------------------------------------- */

      res.json(result);

    } catch (error) {

      console.error(
        'URL metadata error:',
        error
      );

      res.status(500).json({
        success: false,
        error: formatError(error)
      });

    } finally {

      if (tempPath) {

        await fs
          .unlink(tempPath)
          .catch(() => {});
      }
    }
  }
);

/* =========================================================================
   404
   ========================================================================= */

app.use(
  (req, res) => {

    res.status(404).json({
      success: false,
      error: 'Endpoint not found.'
    });

  }
);

/* =========================================================================
   GLOBAL ERROR HANDLER
   ========================================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      'Unhandled error:',
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      success: false,
      error: formatError(error)
    });

  }
);

/* =========================================================================
   START SERVER
   ========================================================================= */

app.listen(
  PORT,

  () => {

    console.log('');
    console.log(
      '=============================================='
    );

    console.log(
      ' TRACE Metadata Backend Started'
    );

    console.log(
      '=============================================='
    );

    console.log(
      `Server: http://localhost:${PORT}`
    );

    console.log(
      `Health: http://localhost:${PORT}/health`
    );

    console.log(
      `Upload: http://localhost:${PORT}/api/metadata`
    );

    console.log(
      `URL:    http://localhost:${PORT}/api/metadata-url`
    );

    console.log(
      'ExifTools API: configured'
    );

    console.log(
      '=============================================='
    );

    console.log('');
  }
);