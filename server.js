/**
 * server.js
 * -------------------------------------------------------------------------
 * Photo + Video Metadata Backend
 *
 * EXIFTOOL API
 *   → EXIF
 *   → IPTC
 *   → XMP
 *   → GPS
 *   → Camera information
 *   → Date/time
 *   → Image/file metadata
 *
 * MEDIAINFO
 *   → Video codec
 *   → Audio codec
 *   → Resolution
 *   → FPS
 *   → Bitrate
 *   → Duration
 *   → Audio channels
 *
 * Supported input:
 *   1. File upload
 *   2. Remote URL
 *
 * -------------------------------------------------------------------------
 *
 * Install:
 *
 *   npm init -y
 *   npm install express multer cors dotenv
 *
 * MediaInfo CLI is also required for deep video/audio metadata.
 *
 * -------------------------------------------------------------------------
 *
 * .env
 *
 *   EXIFTOOL_API_KEY=YOUR_API_KEY_HERE
 *   PORT=4000
 *
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

// Node.js 18+ has built-in fetch.
// If you're using Node.js <18, install node-fetch@2.
const fetch = global.fetch;

const app = express();

/* -------------------------------------------------------------------------
   CONFIG
------------------------------------------------------------------------- */

const PORT = process.env.PORT || 4000;

const EXIFTOOL_API_URL =
  'https://exiftools.com/api/v1/extract';

const EXIFTOOL_API_KEY =
  process.env.EXIFTOOL_API_KEY;

if (!EXIFTOOL_API_KEY) {
  console.error(
    'ERROR: EXIFTOOL_API_KEY is missing from your .env file.'
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------
   MIDDLEWARE
------------------------------------------------------------------------- */

app.use(cors());

app.use(
  express.json({
    limit: '10mb'
  })
);

/* -------------------------------------------------------------------------
   MULTER
------------------------------------------------------------------------- */

const upload = multer({
  dest: os.tmpdir(),

  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

/* -------------------------------------------------------------------------
   HEALTH CHECK
------------------------------------------------------------------------- */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Photo & Video Metadata API'
  });
});

/* =========================================================================
   EXIFTOOL API
   ========================================================================= */

/**
 * Send a local file to ExifTools.com API
 *
 * API:
 * POST https://exiftools.com/api/v1/extract
 *
 * Authentication:
 * X-API-Key
 */
async function extractExifToolMetadata(filePath) {

  const fileBuffer = await fs.readFile(filePath);

  const response = await fetch(
    EXIFTOOL_API_URL,
    {
      method: 'POST',

      headers: {
        'X-API-Key': EXIFTOOL_API_KEY,

        'Content-Type':
          'application/octet-stream'
      },

      body: fileBuffer
    }
  );

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `ExifTools returned invalid JSON: ${responseText}`
    );
  }

  if (!response.ok) {

    throw new Error(
      `ExifTools API error ${response.status}: ${
        data.error || responseText
      }`
    );
  }

  return data;
}

/* =========================================================================
   MEDIAINFO
   ========================================================================= */

/**
 * Extract deep video/audio metadata using MediaInfo CLI.
 *
 * This is separate from ExifTools API because MediaInfo provides
 * detailed stream/codec information.
 */
async function extractMediaInfo(filePath) {

  try {

    const { stdout } = await execFileAsync(
      'mediainfo',
      [
        '--Output=JSON',
        filePath
      ]
    );

    return JSON.parse(stdout);

  } catch (error) {

    throw new Error(
      `MediaInfo failed: ${error.message}`
    );
  }
}

/* =========================================================================
   FILE METADATA ENDPOINT
   ========================================================================= */

/**
 * POST /api/metadata
 *
 * File upload:
 *
 * Content-Type:
 * multipart/form-data
 *
 * Field:
 * file
 */
app.post(
  '/api/metadata',
  upload.single('file'),

  async (req, res) => {

    let tempPath = null;

    try {

      /* ---------------------------------------------------------------
         Check uploaded file
      ---------------------------------------------------------------- */

      if (!req.file) {

        return res.status(400).json({
          success: false,
          error:
            'No file uploaded. Use multipart field "file".'
        });
      }

      tempPath = req.file.path;

      const originalName =
        req.file.originalname;

      const mimeType =
        req.file.mimetype || 'application/octet-stream';

      /* ---------------------------------------------------------------
         Initial response
      ---------------------------------------------------------------- */

      const result = {

        success: true,

        file: {
          filename: originalName,
          mimeType: mimeType,
          size: req.file.size
        },

        exiftool: null,

        mediainfo: null,

        errors: []
      };

      /* ===============================================================
         1. EXIFTOOL API
      =============================================================== */

      try {

        result.exiftool =
          await extractExifToolMetadata(
            tempPath
          );

      } catch (error) {

        result.errors.push({
          service: 'exiftool',
          message: error.message
        });
      }

      /* ===============================================================
         2. MEDIAINFO
      =============================================================== */

      if (
        mimeType.startsWith('video/') ||
        mimeType.startsWith('audio/')
      ) {

        try {

          result.mediainfo =
            await extractMediaInfo(
              tempPath
            );

        } catch (error) {

          result.errors.push({
            service: 'mediainfo',
            message: error.message
          });
        }
      }

      /* ---------------------------------------------------------------
         Send response
      ---------------------------------------------------------------- */

      res.json(result);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        success: false,
        error: error.message
      });

    } finally {

      /* ---------------------------------------------------------------
         Delete temporary file
      ---------------------------------------------------------------- */

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
 * JSON:
 *
 * {
 *   "url": "https://example.com/photo.jpg"
 * }
 *
 * The server downloads the file temporarily and sends it to
 * ExifTools.com.
 */
app.post(
  '/api/metadata-url',

  async (req, res) => {

    let tempPath = null;

    try {

      const { url } = req.body;

      if (!url) {

        return res.status(400).json({
          success: false,
          error: 'URL is required.'
        });
      }

      /* ---------------------------------------------------------------
         Basic URL validation
      ---------------------------------------------------------------- */

      let parsedUrl;

      try {

        parsedUrl = new URL(url);

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
      ---------------------------------------------------------------- */

      const response = await fetch(
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
        ) || 'application/octet-stream';

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      /* ---------------------------------------------------------------
         Create temporary file
      ---------------------------------------------------------------- */

      tempPath = path.join(
        os.tmpdir(),
        crypto.randomUUID()
      );

      await fs.writeFile(
        tempPath,
        buffer
      );

      /* ---------------------------------------------------------------
         Result
      ---------------------------------------------------------------- */

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
         EXIFTOOL API
      =============================================================== */

      try {

        result.exiftool =
          await extractExifToolMetadata(
            tempPath
          );

      } catch (error) {

        result.errors.push({
          service: 'exiftool',
          message: error.message
        });
      }

      /* ===============================================================
         MEDIAINFO
      =============================================================== */

      if (
        mimeType.startsWith('video/') ||
        mimeType.startsWith('audio/')
      ) {

        try {

          result.mediainfo =
            await extractMediaInfo(
              tempPath
            );

        } catch (error) {

          result.errors.push({
            service: 'mediainfo',
            message: error.message
          });
        }
      }

      res.json(result);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        success: false,
        error: error.message
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
      ' Metadata Backend Started'
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
      'ExifTools API: Connected'
    );

    console.log(
      '=============================================='
    );
    console.log('');
  }
);