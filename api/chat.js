const { handleChat } = require('../src/server/chat-handler');

module.exports = async function (req, res) {
  await handleChat(req, res);
};
