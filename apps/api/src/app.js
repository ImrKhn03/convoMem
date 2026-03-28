'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const { errorHandler } = require('./middleware/errorHandler');

// Route imports
const authRoutes = require('./routes/auth.routes');
const memoriesRoutes = require('./routes/memories.routes');
const statsRoutes = require('./routes/stats.routes')
const userWebhooksRoutes = require('./routes/user-webhooks.routes');
const userRoutes = require('./routes/user.routes');
const extensionRoutes = require('./routes/extension.routes');
const entitiesRoutes = require('./routes/entities.routes');

const app = express();

// Security
app.use(helmet());

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((o) => o.trim());

function isOriginAllowed(origin) {
  return allowedOrigins.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed.startsWith('*')) return origin.endsWith(allowed.slice(1));  // *.figma.site
    if (allowed.endsWith('*')) return origin.startsWith(allowed.slice(0, -1)); // chrome-extension://*
    return allowed === origin;
  });
}

app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile, curl, etc.)
      if (!origin || isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(
  morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
    skip: (req) => req.path === '/health',
  })
);

// API documentation
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ConvoMem API',
      version: '1.0.0',
      description: 'AI-powered personal memory system API',
    },
    servers: [{ url: process.env.API_URL || 'http://localhost:8000' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
    },
  },
  apis: ['./src/routes/*.js', './src/controllers/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/memories', memoriesRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/user-webhooks', userWebhooksRoutes);
app.use('/api/user', userRoutes);
app.use('/api/extension', extensionRoutes);
app.use('/api/entities', entitiesRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// Global error handler (must be last)
app.use(errorHandler);

module.exports = app;
