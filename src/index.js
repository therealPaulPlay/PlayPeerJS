import { Peer } from 'peerjs';

const ERROR_PREFIX = "PlayPeer error: ";
const WARNING_PREFIX = "PlayPeer warning: ";

/**
 * @class
 * @classdesc Integrate peer-2-peer multiplayer with ease
 */
export default class PlayPeer {
    // Config properties
    id;
    #peer;
    #options;

    // Event callbacks stored in a map
    #callbacks = new Map();

    // Logic properties
    #storage = {};
    #isHost = false;
    #hostConnections = new Set(); // Host-side array containing all peers connected to current host, send out IDs to clients
    #hostConnectionsIdArray = []; // Client-side array to store the host's connections' IDs.
    #outgoingConnection;

    // Heartbeat variables
    #heartbeatSendInterval;
    #heartbeatReceived;

    /**
     * WebRTC Data Channels wrapper for handling multiplayer in games
     * @constructor
     * @param {string} id - Unique id for signalling
     * @param {object} [options] - Peer options (ice config, host, port etc.)
     */
    constructor(id, options) {
        this.id = id;
        if (options) this.#options = options;
    }

    /** 
     * Register an event callback
     * @param {string} event - Event name (e.g., "incomingPeerConnected", "outgoingPeerError")
     * @param {function} callback - Callback function to register 
     */
    onEvent(event, callback) {
        const validEvents = [
            "status",
            "error",
            "destroy",
            "storageUpdate",
            "incomingPeerConnected",
            "incomingPeerDisconnected",
            "incomingPeerError",
            "outgoingPeerConnected",
            "outgoingPeerDisconnected",
            "outgoingPeerError"
        ];

        if (!validEvents.includes(event)) return console.warn(WARNING_PREFIX + `Invalid event type "${event}" provided to onEvent.`);
        this.#callbacks.set(event, callback);
    }

    /**
     * Trigger event and invoke callback dynamically
     * @param {string} event - Event name
     * @param {...any} args - Arguments to pass to the callback
     * @private
     */
    #triggerEvent(event, ...args) {
        const callback = this.#callbacks.get(event);
        if (!callback) return;

        try {
            callback(...args);
        } catch (error) {
            console.error(ERROR_PREFIX + `${event} callback error:`, error);
        }
    }

    /**
     * Initialize new multiplayer object
     * @async
     * @returns {Promise} Async Initialization promise
    */
    async init() {
        return new Promise((resolve, reject) => {
            this.destroy(); // If peer already exists, destroy
            if (!this.id) console.warn(ERROR_PREFIX + "No id provided!");
            if (!this.#options) console.warn(ERROR_PREFIX + "No config provided! Necessary stun and turn servers missing.");
            this.#triggerEvent("status", "Initializing instance...");

            try {
                this.#peer = new Peer(this.id, this.#options);
            } catch (error) {
                console.error(ERROR_PREFIX + "Failed to initialize peer:", error);
                this.#triggerEvent("error", "Failed to initialize peer: " + error);
                reject(new Error("Failed to initialize peer."));
                return;
            }

            this.#setupPeerErrorListeners(); // Attach event listeners
            this.#peer.on('connection', this.#handleIncomingConnections.bind(this)); // Attach host logic (on-connection listener)

            // Wait for signalling server connection to open
            let connectionOpenTimeout;

            connectionOpenTimeout = setTimeout(() => {
                console.error(ERROR_PREFIX + "Connection attempt to signalling server timed out.");
                this.#triggerEvent("error", "Connection attempt to singalling server timed out.");
                this.destroy();
                reject(new Error("Connection attempt to signalling server timed out."));
            }, 1000);

            this.#peer.on('open', () => {
                this.#triggerEvent("status", "Connected to signalling server!");
                clearTimeout(connectionOpenTimeout);
                resolve();
            });
        });
    }

    /**
     * Set up peer event listeners that refernece the own, internal peer
     * @private
     */
    #setupPeerErrorListeners() {
        this.#peer.on('disconnected', () => {
            if (this.#peer && !this.#peer?.destroyed) {
                try {
                    this.#peer.reconnect();
                    console.warn(WARNING_PREFIX + "Disconnected from signalling server. Attempting to reconnect.");
                    this.#triggerEvent("status", "Disconnected from signalling server...");
                } catch (error) {
                    console.error(ERROR_PREFIX + "Failed to reconnect:", error);
                    this.#triggerEvent("error", "Failed to reconnect: " + error);
                }
            }
        });

        this.#peer.on('error', (error) => {
            if (error.type === "network") {
                console.error(ERROR_PREFIX + "Fatal network error:", error);
                this.#triggerEvent("error", "Fatal network error: " + error);
                this.destroy();
            } else {
                console.error(ERROR_PREFIX + "Peer error:", error);
                this.#triggerEvent("error", "Peer error: " + error);
            }
        });

        this.#peer.on('close', () => {
            this.#triggerEvent("status", "Peer permanently closed.");
            console.error(ERROR_PREFIX + "Connection permanently closed.");
            this.destroy();
        });
    }

    /**
     * Handle incoming peer connections (Host code)
     * @private
     */
    #handleIncomingConnections(incomingConnection) {
        // Close broken connections that don't open or address the wrong host (delay ensures the close event triggers on peers)
        setTimeout(() => {
            if (!incomingConnection.open || !this.#isHost) {
                try {
                    if (this.#isHost) console.warn(WARNING_PREFIX + `Connection ${incomingConnection.peer} closed - no response.`);
                    if (!this.#isHost) console.warn(WARNING_PREFIX + `Connection ${incomingConnection.peer} closed - you are not hosting.`);
                    incomingConnection.close();
                    this.#hostConnections.delete(incomingConnection);
                } catch (error) {
                    console.error(ERROR_PREFIX + "Error closing invalid connection:", error);
                }
            }
        }, 3 * 1000);

        // Only process incoming connections if hosting
        if (this.#isHost) {
            this.#triggerEvent("status", "New peer connected.");
            this.#hostConnections.add(incomingConnection);

            incomingConnection.on('open', () => {
                this.#triggerEvent("status", "Incoming connection opened.");
                this.#triggerEvent("incomingPeerConnected", incomingConnection.peer);

                // Sync host's connections with all peers
                const peerList = Array.from(this.#hostConnections).map((conn) => conn.peer);
                this.#broadcastMessage("peer_list", { peers: peerList });

                // Send current storage state to new peer
                try {
                    incomingConnection.send({ type: 'storage_sync', storage: this.#storage });
                } catch (error) {
                    console.error(ERROR_PREFIX + "Error sending initial storage sync:", error);
                    this.#triggerEvent("error", "Error sending initial storage sync: " + error);
                }
            });

            incomingConnection.on('data', (data) => {
                if (!data || !data?.type) return;

                switch (data.type) {
                    case 'storage_update':
                        // Storage updates, sent out by clients
                        if (this.#isHost) {
                            this.#setStorageLocally(data.key, data.value);
                            this.#broadcastMessage("storage_sync", { storage: this.#storage });
                        }
                        break;
                    case 'heartbeat_request': {
                        // Respond to peers requesting heartbeat
                        try {
                            incomingConnection.send({ type: "heartbeat_response" });
                        } catch (error) {
                            console.error(ERROR_PREFIX + "Error responding to heartbeat:", error);
                            this.#triggerEvent("error", "Error responding to heartbeat: " + error);
                        }
                        break;
                    }
                }
            });

            incomingConnection.on('close', () => {
                this.#hostConnections.delete(incomingConnection);
                this.#triggerEvent("incomingPeerDisconnected", incomingConnection.peer);
                this.#triggerEvent("status", "Incoming connection closed.");

                const peerList = Array.from(this.#hostConnections).map((conn) => conn.peer);
                this.#broadcastMessage("peer_list", { peers: peerList });
            });

            incomingConnection.on('error', (error) => {
                this.#triggerEvent("incomingPeerError", incomingConnection.peer);
                console.error(ERROR_PREFIX + `Connection ${incomingConnection.peer} error:`, error);
                this.#triggerEvent("error", "Error in incoming connection: " + error);
            });
        } else {
            console.warn(WARNING_PREFIX + "Incoming connection ignored as peer is not hosting.");
        }
    }

    /**
     * Create room and become host
     * @param {object} initialStorage - Initial storage object
     * @returns {Promise} Promise resolves with peer id
     */
    createRoom(initialStorage = {}) {
        if (!this.#peer || this.#peer.destroyed) {
            this.#triggerEvent("error", "Cannot create room if peer is not initialized.");
            console.error(ERROR_PREFIX + "Cannot create room if peer is not initialized.");
            reject(new Error("Peer not initialized."));
        }
        return new Promise((resolve) => {
            this.#isHost = true;
            this.#storage = initialStorage;
            this.#triggerEvent("status", "Room created.");
            resolve(this.id);
        });
    }

    /**
     * Join existing room (Client code)
     * @param {string} hostId - Id of the host to connect to
     */
    async joinRoom(hostId) {
        return new Promise((resolve, reject) => {
            if (!this.#peer || this.#peer.destroyed) {
                this.#triggerEvent("error", "Cannot join room if peer is not initialized.");
                console.error(ERROR_PREFIX + "Cannot join room if peer is not initialized.");
                reject(new Error("Peer not initialized."));
            }
            try {
                if (this.#outgoingConnection) this.#outgoingConnection.close(); // Close previous connection (if exists)
                this.#outgoingConnection = this.#peer.connect(hostId, { reliable: true }); // Connect to host
                this.#triggerEvent("status", "Connecting to host...");

                // In case peer experiences error joining room, reject promise
                this.#peer.on('error', (error) => {
                    reject(new Error("Error occured trying to join room: " + error));
                });

                // Connection timeout
                let timeout;
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    if (this.#outgoingConnection && !this.#outgoingConnection.open) {
                        this.#outgoingConnection.close();
                        this.#outgoingConnection = null;
                    }
                    console.error(ERROR_PREFIX + "Connection attempt for joining room timed out.");
                    this.#triggerEvent("status", "Connection attempt for joining room timed out.");
                    reject(new Error("Connection attempt for joining room timed out."));
                }, 3 * 1000);

                this.#outgoingConnection.on("open", () => {
                    clearTimeout(timeout);
                    this.#triggerEvent("outgoingPeerConnected", hostId);
                    this.#triggerEvent("status", "Connection to host established.");

                    // Regularly check if host responds to heartbeat
                    this.#heartbeatReceived = true;
                    this.#heartbeatSendInterval = setInterval(() => {
                        if (!this.#isHost) {
                            if (!this.#heartbeatReceived) {
                                console.warn(WARNING_PREFIX + "Host did not respond to heartbeat - disconnecting from host.");
                                this.#triggerEvent("status", "Host did not respond to heartbeat - disconnecting.");
                                this.#outgoingConnection?.close();
                                return;
                            }

                            // Ping host
                            if (this.#outgoingConnection?.open) {
                                this.#outgoingConnection?.send({
                                    type: 'heartbeat_request'
                                });
                            }
                        } else {
                            clearInterval(this.#heartbeatSendInterval);
                        }
                    }, 1000);

                    // Only migrate host if the connection was initially open
                    this.#outgoingConnection.on('close', () => {
                        this.#migrateHost();
                    });

                    resolve();
                });

                this.#outgoingConnection.on('data', (data) => {
                    if (!data || !data?.type) return;
                    switch (data.type) {
                        case 'storage_sync':
                            this.#storage = data.storage;
                            this.#triggerEvent("storageUpdate", this.#storage);
                            break;
                        case 'peer_list':
                            this.#hostConnectionsIdArray = data.peers;
                            break;
                        case 'heartbeat_response':
                            this.#heartbeatReceived = true;
                            break;

                    }
                });

                this.#outgoingConnection.on('close', () => {
                    this.#triggerEvent("outgoingPeerDisconnected", hostId);
                    this.#triggerEvent("status", "Connection to host closed.");
                });

                this.#outgoingConnection.on('error', (error) => {
                    clearTimeout(timeout);
                    this.#triggerEvent("outgoingPeerError", hostId);
                    console.error(ERROR_PREFIX + `Host connection error:`, error);
                    this.#triggerEvent("error", "Error in host connection: " + error);
                    reject(error);
                });
            } catch (error) {
                console.error(ERROR_PREFIX + "Error connecting to host:", error);
                this.#triggerEvent("error", "Error connecting to host: " + error);
                reject(error);
            }
        });
    }

    /**
     * Update storage with new value
     * @public
     * @param {string} key - Storage key to update
     * @param {*} value - New value
     */
    updateStorage(key, value) {
        if (this.#isHost) {
            this.#setStorageLocally(key, value);
            this.#broadcastMessage("storage_sync", { storage: this.#storage });
        } else {
            try {
                this.#outgoingConnection?.send({
                    type: 'storage_update',
                    key,
                    value
                });
            } catch (error) {
                console.error(ERROR_PREFIX + "Error sending storage update to host:", error);
                this.#triggerEvent("error", "Error sending storage update to host: " + error);
            }
            this.#setStorageLocally(key, value); // Optimistic update for non-host peers Ref: https://medium.com/@kyledeguzmanx/what-are-optimistic-updates-483662c3e171
        }
    }

    /**
     * Update local storage and trigger callback
     * @private
     */
    #setStorageLocally(key, value) {
        this.#storage[key] = value;
        this.#triggerEvent("storageUpdate", this.#storage);
    }

    /**
     * Broadcast a message of a specific type to all peers. Used by host only
     * @private
     * @param {string} type - Message type (e.g., "storage_sync", "peer_list")
     * @param {object} [payload] - Additional data to send
     */
    #broadcastMessage(type, payload = {}) {
        const message = { type, ...payload };
        this.#hostConnections.forEach((connection) => {
            if (connection.open) {
                try {
                    connection.send(message);
                } catch (error) {
                    console.error(ERROR_PREFIX + `Failed to send broadcast message to peer ${connection.peer}:`, error);
                    this.#triggerEvent("error", `Failed to send broadcast message to peer ${connection.peer}: ${error}`);
                }
            }
        });
    }

    /**
     * Handle host migration when current host disconnects
     * @async
     * @private
     */
    async #migrateHost() {
        this.#triggerEvent("status", "Starting host migration...");
        const connectedPeerIds = this.#hostConnectionsIdArray;
        connectedPeerIds.sort();

        const migrateToHostIndex = async (index) => {
            if (index >= connectedPeerIds.length) return;

            if (connectedPeerIds[index] === this.id) {
                this.#isHost = true;
                this.#triggerEvent("status", `This peer (index ${index}) is now the host.`);
                this.#outgoingConnection = null;
            } else {
                this.#triggerEvent("status", `Attempting to connect to new host (index ${index}) in 1s...`);
                try {
                    await new Promise(resolve => setTimeout(resolve, 1250));
                    await this.joinRoom(connectedPeerIds[index]);
                } catch (error) {
                    this.#triggerEvent("error", "Error migrating host while connecting to new room: " + error);
                    console.warn(WARNING_PREFIX + `Error migrating host (index ${index}) while connecting to new room:`, error);
                    await migrateToHostIndex(index + 1);
                }
            }
        }

        await migrateToHostIndex(0);
    }

    /**
     * Clean up and destroy peer
     */
    destroy() {
        try {
            if (this.#peer) {
                if (!this.#peer?.destroyed) this.#peer.destroy();

                // Trigger events
                this.#triggerEvent("status", "Destroyed.");
                this.#triggerEvent("destroy");
            }

            // Resets
            this.#peer = undefined;
            this.#storage = {};
            this.#isHost = false;
            this.#hostConnections.clear();
            this.#hostConnectionsIdArray = [];

            // Clear intervals
            clearInterval(this.#heartbeatSendInterval);
            this.#triggerEvent("status", "Resetted internal data.");
        } catch (error) {
            console.error(ERROR_PREFIX + "Error during cleanup:", error);
            this.#triggerEvent("error", "Error during cleanup: " + error);
        }
    }

    /**
     *  @returns {number} Number of active connections to the host
     */
    get connectionCount() {
        if (this.#isHost) return this.#hostConnections?.size || 0;
        return this.#hostConnectionsIdArray?.length || 0;
    }

    /**
     *  @returns {object} Get storage object
     */
    get getStorage() {
        return this.#storage || {};
    }
}