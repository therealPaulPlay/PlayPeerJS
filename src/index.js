import { Peer } from 'peerjs';
import { CRDTManager } from './crdtManager';

const ERROR_PREFIX = "PlayPeer error: ";
const WARNING_PREFIX = "PlayPeer warning: ";

/**
 * @class
 * @classdesc Integrate peer-2-peer multiplayer with ease
 */
export default class PlayPeer {
    // Config properties
    #id;
    #peer;
    #options;
    #initialized = false;
    #maxSize;
    #crdtManager;

    // Event callbacks stored in a map
    #callbacks = new Map();

    // Logic properties
    #isHost = false;
    #hostConnections = []; // Host-side array containing all peers connected to current host, send out IDs to clients
    #hostConnectionsIdArray = []; // Client-side array to store the host's connections' IDs.
    #outgoingConnection;

    // Heartbeat variables
    #heartbeatSendInterval;
    #heartbeatHostCheckInterval;
    #heartbeatReceived;

    /**
     * WebRTC Data Channels wrapper for handling multiplayer in games
     * @constructor
     * @param {string} id - Unique id for signalling
     * @param {object} [options] - Peer options (ice config, host, port etc.)
     */
    constructor(id, options) {
        this.#id = id;
        this.#crdtManager = new CRDTManager(this.#id);
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
            "instanceDestroyed",
            "storageUpdated",
            "hostMigrated",
            "incomingPeerConnected",
            "incomingPeerDisconnected",
            "incomingPeerError",
            "outgoingPeerConnected",
            "outgoingPeerDisconnected",
            "outgoingPeerError"
        ];

        if (!validEvents.includes(event)) return console.warn(WARNING_PREFIX + `Invalid event type "${event}" provided to onEvent.`);
        if (!this.#callbacks.has(event)) this.#callbacks.set(event, []); // If not present, add event array
        this.#callbacks.get(event).push(callback); // Push callback into array
    }

    /**
     * Trigger event and invoke callback dynamically
     * @param {string} event - Event name
     * @param {...any} args - Arguments to pass to the callback
     * @private
     */
    #triggerEvent(event, ...args) {
        const callbacks = this.#callbacks.get(event);
        callbacks?.forEach((callback) => {
            try {
                callback(...args);
            } catch (error) {
                console.error(ERROR_PREFIX + `${event} callback error:`, error);
            }
        });
    }

    /**
     * Initialize new multiplayer object
     * @async
     * @returns {Promise} Async Initialization promise
    */
    async init() {
        return new Promise((resolve, reject) => {
            if (this.#peer) return reject(new Error("Instance already initialized!"));
            if (!this.#id) return reject(ERROR_PREFIX + "No id provided!");
            if (!this.#options) return reject(ERROR_PREFIX + "No config provided! Stun and turn servers missing.");
            this.#triggerEvent("status", "Initializing instance...");

            try {
                this.#peer = new Peer(this.#id, this.#options);
            } catch (error) {
                console.error(ERROR_PREFIX + "Failed to initialize peer:", error);
                this.#triggerEvent("error", "Failed to initialize peer: " + error);
                return reject(new Error("Failed to initialize peer."));
            }

            this.#setupPeerErrorListeners(); // Attach event listeners
            this.#peer.on('connection', this.#handleIncomingConnections.bind(this)); // Attach host logic (on-connection listener)

            // Wait for signalling server connection to open
            let connectionOpenTimeout;

            connectionOpenTimeout = setTimeout(() => {
                this.#triggerEvent("error", "Connection attempt to singalling server timed out.");
                this.destroy();
                reject(new Error("Connection attempt to signalling server timed out."));
            }, 3 * 1000);

            this.#peer.on('open', () => {
                this.#triggerEvent("status", "Connected to signalling server!");
                clearTimeout(connectionOpenTimeout);
                this.#initialized = true;
                resolve(this.#id);
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
                    this.#peer.reconnect(); // Re-connect to the signalling server – all active peer connections should stay intact!
                    console.warn(WARNING_PREFIX + "Disconnected from signalling server. Attempting to reconnect.");
                    this.#triggerEvent("status", "Disconnected from signalling server...");
                } catch (error) {
                    this.#triggerEvent("error", "Failed to reconnect: " + error);
                }
            }
        });

        this.#peer.on('error', (error) => {
            this.#triggerEvent("error", `Error of type '${error?.type}': ` + error); // Don't destroy here - it's either done automatically (including on browser reload) or unnecessary
        });

        // 'close' is triggered when the peer was destroyed either by peer.destroy() or by fatal error
        this.#peer.on('close', () => {
            this.#triggerEvent("status", "Peer permanently closed.");
            this.#triggerEvent("error", "Peer permanently closed. Please ensure your client is WebRTC-compatible.");
            console.warn(WARNING_PREFIX + "Peer permanently closed.");
            this.destroy(); // Clean up and trigger PlayPeer destroy event (if not already destroyed)
        });
    }

    /**
     * Remove incoming connection from the host connections array
     * @param {object} incomingConnection 
     */
    #removeIncomingConnectionFromArray(incomingConnection) {
        const removeIndex = this.#hostConnections.findIndex(c => c[0] === incomingConnection);
        if (removeIndex !== -1) this.#hostConnections.splice(removeIndex, 1);
        const peerList = Array.from(this.#hostConnections).map(c => c[0]?.peer);
        this.#broadcastMessage("peer_list", { peers: peerList });
    }

    /**
     * Handle incoming peer connections (Host function)
     * @private
     */
    #handleIncomingConnections(incomingConnection) {
        // Check if room is full
        if (this.#isHost && this.#maxSize && (this.#hostConnections?.length + 1) >= this.#maxSize) {
            console.warn(WARNING_PREFIX + `Connection ${incomingConnection.peer} rejected - room is full.`);
            this.#triggerEvent("status", "Rejected connection - room is full.");
            try { incomingConnection.close(); } catch (error) {
                this.#triggerEvent("error", "Failed to close incoming connection (room full): " + error);
            }
            return; // Don't continue with the rest of events
        }

        // Close broken connections that don't open in time or address the wrong host
        setTimeout(() => {
            if (!incomingConnection.open || !this.#isHost) {
                console.warn(WARNING_PREFIX + `Connection ${incomingConnection?.peer} closed - ${this.#isHost ? "did not open" : "not hosting"}.`);
                try { incomingConnection.close(); } catch (error) {
                    this.#triggerEvent("error", "Failed to close incoming connection (invalid): " + error);
                }
            }
        }, 3 * 1000);

        // Only process incoming connections if hosting
        if (this.#isHost) {
            // Add new peer immediately (not after 'open') to ensure room size limits work properly
            this.#triggerEvent("status", "New peer connecting...");
            if (this.#hostConnections.findIndex(c => c[0] === incomingConnection) == -1) this.#hostConnections.push([incomingConnection, Date.now()]);

            // Set up host heartbeat check if not already
            if (!this.#heartbeatHostCheckInterval) {
                this.#heartbeatHostCheckInterval = setInterval(() => {
                    if (!this.#isHost) {
                        clearInterval(this.#heartbeatHostCheckInterval);
                        this.#heartbeatHostCheckInterval = undefined;
                        return;
                    }
                    this.#hostConnections?.forEach((e) => {
                        if (e[1] < Date.now() - 3000) {
                            console.warn(WARNING_PREFIX + "Peer did not send heartbeats - closing connection.");
                            this.#triggerEvent("status", "Peer did not send heartbeats - closing connection.");
                            try { e[0]?.close(); } catch (error) {
                                this.#triggerEvent("error", "Failed to close incoming connection (no heartbeat): " + error);
                            }
                            this.#removeIncomingConnectionFromArray(e[0]); // Remove the entry now, regardless if the close worked
                        }
                    });
                }, 1000);
            }

            incomingConnection.on('open', () => {
                // Sync host's connections with all peers
                const peerList = Array.from(this.#hostConnections).map(c => c[0]?.peer);
                this.#broadcastMessage("peer_list", { peers: peerList });

                this.#triggerEvent("status", "Incoming connection opened.");
                this.#triggerEvent("incomingPeerConnected", incomingConnection.peer);

                // Send current storage state to new peer
                try {
                    incomingConnection.send({ type: 'state_init', state: this.#crdtManager.getState });
                } catch (error) {
                    this.#triggerEvent("error", "Error sending initial storage sync: " + error);
                }
            });

            incomingConnection.on('data', (data) => {
                if (!data || !data?.type) return;

                switch (data.type) {
                    case 'property_update_request':
                        // Storage updates, sent out by clients
                        if (data.update) {
                            this.#crdtManager.importPropertyUpdate(data.update);
                            if (this.#crdtManager.didPropertiesChange) this.#triggerEvent("storageUpdated", this.getStorage);
                            this.#broadcastMessage("property_update", { update: data.update });
                        }
                        break;
                    case 'heartbeat_request': {
                        // Respond to peers requesting heartbeat
                        try {
                            incomingConnection.send({ type: "heartbeat_response" });
                            const index = this.#hostConnections.findIndex(e => e[0] == incomingConnection);
                            if (index !== -1) this.#hostConnections[index][1] = Date.now(); // Update last heartbeat to now
                        } catch (error) {
                            this.#triggerEvent("error", "Error responding to heartbeat: " + error);
                        }
                        break;
                    }
                }
            });

            incomingConnection.on('close', () => {
                this.#removeIncomingConnectionFromArray(incomingConnection);
                this.#triggerEvent("incomingPeerDisconnected", incomingConnection?.peer);
                this.#triggerEvent("status", "Incoming connection closed.");
            });

            incomingConnection.on('error', (error) => {
                this.#triggerEvent("incomingPeerError", incomingConnection.peer);
                this.#triggerEvent("error", "Error in incoming connection: " + error);
            });
        }
    }

    /**
     * Create room and become host
     * @param {object} initialStorage - Initial storage object
     * @param {number} [maxSize] - Optional maximum number of peers allowed in the room
     * @returns {Promise} Promise resolves with peer id
     */
    createRoom(initialStorage = {}, maxSize) {
        return new Promise((resolve, reject) => {
            if (!this.#peer || this.#peer.destroyed || !this.#initialized) {
                this.#triggerEvent("error", "Cannot create room if peer is not initialized. Note that .init() is async.");
                console.error(ERROR_PREFIX + "Cannot create room if peer is not initialized. Note that .init() is async.");
                reject(new Error("Peer not initialized."));
            }

            // Initial storage
            Object.entries(initialStorage)?.forEach(([key, value]) => {
                this.#crdtManager.updateProperty(key, "set", value);
            });

            this.#isHost = true;
            this.#maxSize = maxSize; // Store the maxSize value
            this.#triggerEvent("storageUpdated", this.getStorage);
            this.#triggerEvent("status", `Room created${maxSize ? ` with size ${maxSize}` : ''}.`);
            resolve(this.#id);
        });
    }

    /**
     * Join existing room (Client code)
     * @param {string} hostId - Id of the host to connect to
     */
    async joinRoom(hostId) {
        return new Promise((resolve, reject) => {
            if (!this.#peer || this.#peer?.destroyed || !this.#initialized) {
                this.#triggerEvent("error", "Cannot join room if peer is not initialized. Note that .init() is async.");
                console.error(ERROR_PREFIX + "Cannot join room if peer is not initialized. Note that .init() is async.");
                reject(new Error("Peer not initialized."));
            }
            try {
                this.#outgoingConnection = this.#peer.connect(hostId, { reliable: true }); // Connect to host
                this.#triggerEvent("status", "Connecting to host...");

                // In case peer experiences error joining room, reject promise
                this.#peer.once('error', error => {
                    reject(new Error("Error occurred trying to join room: " + error));
                });

                // Connection timeout
                let timeout;
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    if (this.#outgoingConnection && !this.#outgoingConnection.open) {
                        this.#outgoingConnection.close();
                        this.#outgoingConnection = null;
                    }
                    this.#triggerEvent("status", "Connection attempt for joining room timed out.");
                    reject(new Error("Connection attempt for joining room timed out."));
                }, 5 * 1000);

                let failedHeartbeatAttempts = 0;

                this.#outgoingConnection.on("open", () => {
                    clearTimeout(timeout);
                    this.#triggerEvent("outgoingPeerConnected", hostId);
                    this.#triggerEvent("status", "Connection to host established.");

                    // Regularly check if host responds to heartbeat
                    this.#heartbeatReceived = true;
                    clearInterval(this.#heartbeatSendInterval); // Prevent multiple ones stacking up
                    this.#heartbeatSendInterval = setInterval(() => {
                        if (this.#isHost) return clearInterval(this.#heartbeatSendInterval);
                        if (!this.#heartbeatReceived) {
                            failedHeartbeatAttempts++;
                            if (failedHeartbeatAttempts >= 2) {
                                console.warn(WARNING_PREFIX + "Host did not respond to heartbeat twice - disconnecting from host.");
                                this.#triggerEvent("status", "Host did not respond to heartbeat twice - disconnecting from host.");
                                this.#outgoingConnection?.close();
                                return;
                            }
                        }

                        // Ping host
                        this.#heartbeatReceived = false; // Reset received status to false
                        if (this.#outgoingConnection?.open) {
                            this.#outgoingConnection?.send({
                                type: 'heartbeat_request'
                            });
                        }
                    }, 1000);

                    // Only migrate host if the connection was initially open
                    this.#outgoingConnection.on('close', () => {
                        clearInterval(this.#heartbeatSendInterval);
                        if (!this.#isHost) this.#migrateHost();
                    });

                    resolve();
                });

                this.#outgoingConnection.on('data', (data) => {
                    if (!data || !data?.type) return;
                    switch (data.type) {
                        case 'state_init':
                            if (data.state) {
                                this.#crdtManager.importState(data.state);
                                this.#triggerEvent("storageUpdated", this.getStorage);
                            }
                            break;

                        case 'property_update':
                            if (data.update) {
                                this.#crdtManager.importPropertyUpdate(data.update);
                                if (this.#crdtManager.didPropertiesChange) this.#triggerEvent("storageUpdated", this.getStorage);
                            }
                            break;

                        case 'peer_list':
                            this.#hostConnectionsIdArray = data.peers;
                            break;
                        case 'heartbeat_response':
                            this.#heartbeatReceived = true;
                            failedHeartbeatAttempts = 0;
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
                    this.#triggerEvent("error", "Error in host connection: " + error);
                });
            } catch (error) {
                this.#triggerEvent("error", "Error in connection to host: " + error);
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
        const propUpdate = this.#crdtManager.updateProperty(key, "set", value); // Optimistic update
        if (this.#isHost) {
            this.#broadcastMessage("property_update", { update: propUpdate });
        } else {
            try {
                if (this.#outgoingConnection?.open) {
                    this.#outgoingConnection?.send({
                        type: 'property_update_request',
                        update: propUpdate
                    });
                }
            } catch (error) {
                this.#triggerEvent("error", "Error sending property update to host: " + error);
            }
        }
        if (this.#crdtManager.didPropertiesChange) this.#triggerEvent("storageUpdated", this.getStorage);
    }

    /**
     * Safely update an array from a storage key
     * @param {string} key 
     * @param {string} operation 
     * @param {*} value 
     * @param {* | undefined} updateValue 
     */
    updateStorageArray(key, operation, value, updateValue) {
        const propUpdate = this.#crdtManager.updateProperty(key, "array-" + operation, value, updateValue); // Optimistic update
        if (this.#isHost) {
            this.#broadcastMessage("property_update", { update: propUpdate });
        } else {
            try {
                if (this.#outgoingConnection?.open) {
                    this.#outgoingConnection?.send({
                        type: 'property_update_request',
                        update: propUpdate
                    });
                }
            } catch (error) {
                this.#triggerEvent("error", "Error sending property update to host: " + error);
            }
        }
        if (this.#crdtManager.didPropertiesChange) this.#triggerEvent("storageUpdated", this.getStorage);
    }

    /**
     * Broadcast a message of a specific type to all peers. Used by host only
     * @private
     * @param {string} type - Message type (e.g."peer_list")
     * @param {object} [payload] - Additional data to send
     */
    #broadcastMessage(type, payload = {}) {
        const message = { type, ...payload };
        this.#hostConnections.forEach((element) => {
            const connection = element[0];
            if (connection?.open) {
                try {
                    connection.send(message);
                } catch (error) {
                    this.#triggerEvent("error", `Failed to send broadcast message to peer ${connection?.peer}: ${error}`);
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
        if (this.#peer.destroyed) {
            console.warn(WARNING_PREFIX + "Can't migrate host since peer is destroyed.");
            this.#triggerEvent("error", "Can't migrate host since peer is destroyed.");
            return;
        }
        this.#triggerEvent("status", "Starting host migration...");
        const connectedPeerIds = this.#hostConnectionsIdArray;
        connectedPeerIds.sort();

        const migrateToHostIndex = async (index) => {
            if (index >= connectedPeerIds.length) return;

            if (connectedPeerIds[index] === this.#id) {
                this.#isHost = true;
                this.#outgoingConnection = null;
                this.#triggerEvent("status", `This peer (index ${index}) is now the host.`);
                this.#triggerEvent("hostMigrated", this.#id);
            } else {
                this.#triggerEvent("status", `Attempting to connect to new host (index ${index}) in 1s...`);
                try {
                    await new Promise(resolve => setTimeout(resolve, 1250)); // Wait to give new host time to detect disconnection & open room
                    await this.joinRoom(connectedPeerIds[index]);
                    this.#triggerEvent("hostMigrated", connectedPeerIds[index]);
                } catch (error) {
                    console.warn(WARNING_PREFIX + `Error connecting to room (index ${index}) while migrating host:`, error);
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
        if (this.#peer) {
            try {
                if (!this.#peer?.destroyed) this.#peer.destroy();
            } catch (error) {
                this.#triggerEvent("error", "Error destroying peer: " + error);
            }

            // Trigger events
            this.#triggerEvent("status", "Destroyed.");
            this.#triggerEvent("instanceDestroyed");
        }

        // Clear intervals
        clearInterval(this.#heartbeatSendInterval);
        clearInterval(this.#heartbeatHostCheckInterval);

        // Resets
        this.#peer = undefined;
        this.#isHost = false;
        this.#hostConnections = [];
        this.#hostConnectionsIdArray = [];
        this.#initialized = false;
        this.#maxSize = undefined;
        this.#callbacks.clear();
    }

    /**
     *  @returns {number} Number of active connections to the host
     */
    get connectionCount() {
        if (this.#isHost) return this.#hostConnections?.length || 0;
        return this.#hostConnectionsIdArray?.length || 0;
    }

    /**
     *  @returns {object} Get storage object
     */
    get getStorage() { return this.#crdtManager.getPropertyStore; }

    /**
    *  @returns {boolean} Check if this peer is hosting
    */
    get isHost() { return this.#isHost; }

    get id() { return this.#id; }
}