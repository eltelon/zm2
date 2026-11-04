module.exports = {
  apps : [{
    name: 'API',
    script: 'api.js',
    instances: 1, // compatibility option; always one service
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    }
  }]
};
