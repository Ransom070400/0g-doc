/**
 * Ask-AI dev-server plugin.
 *
 * Docusaurus `yarn start` uses webpack-dev-server, which does not know about
 * Vercel's /api routes. This plugin injects /api/chat middleware into the dev
 * server so the chat widget works locally against the same handler that runs
 * in production on Vercel.
 */

const { handleChat } = require('../server/chat-handler');

module.exports = function askAiDevPlugin() {
  return {
    name: 'ask-ai-dev-plugin',
    configureWebpack(_config, isServer) {
      if (isServer) return {};
      return {
        devServer: {
          setupMiddlewares(middlewares, devServer) {
            if (!devServer?.app) return middlewares;
            devServer.app.post('/api/chat', async (req, res) => {
              try {
                await handleChat(req, res);
              } catch (err) {
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                }
                res.end(JSON.stringify({ error: err.message || 'handler crashed' }));
              }
            });
            devServer.app.options('/api/chat', (req, res) => {
              handleChat(req, res).catch(() => res.end());
            });
            return middlewares;
          },
        },
      };
    },
  };
};
