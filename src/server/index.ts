import { DLServer } from './download-server.js';

const server = new DLServer();
process.once('SIGINT', () => {
  void server.close();
});
process.once('SIGTERM', () => {
  void server.close();
});
