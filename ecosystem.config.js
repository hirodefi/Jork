module.exports = {
  apps: [{
    name: 'jork',
    script: 'src/jork.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
