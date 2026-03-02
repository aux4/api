class ConnectionManager {
  constructor() {
    this.connections = new Map();
  }

  add(connectionId, socket) {
    this.connections.set(connectionId, {
      socket,
      connectedAt: new Date().toISOString()
    });
  }

  get(connectionId) {
    return this.connections.get(connectionId);
  }

  remove(connectionId) {
    this.connections.delete(connectionId);
  }

  send(connectionId, data) {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const message = typeof data === "string" ? data : JSON.stringify(data);
    conn.socket.send(message);
  }

  disconnect(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    conn.socket.close();
    this.connections.delete(connectionId);
  }
}

module.exports = ConnectionManager;
