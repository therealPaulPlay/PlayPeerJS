import { Peer } from 'peerjs';

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
        this.#id = id;
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
        if (!callbacks || callbacks.length === 0) return;

        callbacks.forEach((callback) => {
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
            if (this.#peer) return console.error(ERROR_PREFIX + "Instance already initialized!");
            if (!this.#id) console.warn(ERROR_PREFIX + "No id provided!");
            if (!this.#options) console.warn(ERROR_PREFIX + "No config provided! Necessary stun and turn servers missing.");
            this.#triggerEvent("status", "Initializing instance...");

            try {
                this.#peer = new Peer(this.#id, this.#options);
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
            }, 2 * 1000);

            this.#peer.on('open', () => {
                this.#triggerEvent("status", "Connected to signalling server!");
                clearTimeout(connectionOpenTimeout);
                this.#initialized = true;
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
            console.error(ERROR_PREFIX + `Error of type '${error?.type}':`, error);
            this.#triggerEvent("error", `Error of type '${error?.type}': ` + error);
        });

        this.#peer.on('close', () => {
            this.#triggerEvent("status", "Peer permanently closed.");
            this.#triggerEvent("error", "Peer permanently closed. Please ensure your client is WebRTC-compatible.");
            console.warn(WARNING_PREFIX + "Peer permanently closed.");
            this.destroy();
        });
    }

    /**
     * Handle incoming peer connections (Host code)
     * @private
     */
    #handleIncomingConnections(incomingConnection) {
        // Check if room is full
        if (this.#isHost && this.#maxSize && (this.#hostConnections?.size + 1) >= this.#maxSize) {
            console.warn(WARNING_PREFIX + `Connection ${incomingConnection.peer} rejected - room is full.`);
            this.#triggerEvent("status", "Rejected connection - room is full.");
            incomingConnection.close();
            return; // Don't continue with the rest of events
        }

        // Close broken connections that don't open in time or address the wrong host
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
                        if (this.#isHost && data.key) {
                            this.updateStorage(data.key, data.value);
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
                    case 'array_update': {
                        // Perform array updates on host to avoid race conditions
                        this.#handleArrayUpdate(data.key, data.operation, data.value, data.updateValue);
                        this.#broadcastMessage("storage_sync", { storage: this.#storage });
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

            this.#isHost = true;
            this.#storage = initialStorage;
            this.#maxSize = maxSize; // Store the maxSize value
            this.#triggerEvent("storageUpdated", { ...this.#storage });
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
            if (!this.#peer || this.#peer.destroyed || !this.#initialized) {
                this.#triggerEvent("error", "Cannot join room if peer is not initialized. Note that .init() is async.");
                console.error(ERROR_PREFIX + "Cannot join room if peer is not initialized. Note that .init() is async.");
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
                            // Update storage with host sync only if local save isn't identical
                            if (JSON.stringify(this.#storage) !== JSON.stringify(data.storage)) {
                                this.#storage = data.storage;
                                this.#triggerEvent("storageUpdated", { ...this.#storage });
                            }
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
        if (JSON.stringify(this.#storage[key]) === JSON.stringify(value)) return; // If the key already has this value, exit
        if (this.#isHost) {
            this.#setStorageLocally(key, value);
            this.#broadcastMessage("storage_sync", { storage: this.#storage });
        } else {
            try {
                if (this.#outgoingConnection?.open) {
                    this.#outgoingConnection?.send({
                        type: 'storage_update',
                        key,
                        value
                    });
                }
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
        this.#triggerEvent("storageUpdated", { ...this.#storage });
    }

    /**
     * Handle dynamic array update
     * @private
     * @param {string} key 
     * @param {string} operation 
     * @param {*} value 
     * @param {*} updateValue
     */
    #handleArrayUpdate(key, operation, value, updateValue) {
        let updatedArray = this.#storage?.[key] || [];
        if (!Array.isArray(this.#storage?.[key])) this.#storage[key] = []; // Ensure it's an array if it wasn't already

        switch (operation) {
            case 'add':
                updatedArray.push(value);
                break;

            case 'add-unique':
                // Check if the value already exists (deep comparison for objects)
                const uniqueIndex = updatedArray.findIndex(item => {
                    if (typeof value === 'object' && value !== null) {
                        return JSON.stringify(item) === JSON.stringify(value);
                    }
                    return item === value; // Strict equality for primitives
                });

                if (uniqueIndex == -1) {
                    updatedArray.push(value); // Add the unique value
                }
                break;

            case 'remove-matching':
                // Remove matching value (deep comparison for objects)
                updatedArray = updatedArray.filter(item => {
                    if (typeof value === 'object' && value !== null) {
                        return JSON.stringify(item) !== JSON.stringify(value);
                    }
                    return item !== value; // Strict equality for primitives
                });
                break;

            case 'update-matching':
                // Find and update the matching value (deep comparison for objects)
                const updateIndex = updatedArray.findIndex(item => {
                    if (typeof value === 'object' && value !== null) {
                        return JSON.stringify(item) === JSON.stringify(value);
                    }
                    return item === value; // Strict equality for primitives
                });

                if (updateIndex > -1) {
                    updatedArray[updateIndex] = updateValue; // Perform the update
                }
                break;

            default:
                console.error(ERROR_PREFIX + `Unknown array operation: ${operation}`);
                this.#triggerEvent("error", `Unknown array operation: ${operation}`);
        }

        this.#setStorageLocally(key, updatedArray); // Update storage locally
    }

    /**
     * Safely update an array from a storage key
     * @param {string} key 
     * @param {string} operation 
     * @param {*} value 
     * @param {* | undefined} updateValue 
     */
    updateStorageArray(key, operation, value, updateValue) {
        if (this.#isHost) {
            this.#handleArrayUpdate(key, operation, value, updateValue);
            this.#broadcastMessage("storage_sync", { storage: this.#storage });
        } else {
            try {
                // Request the host to perform the operation
                if (this.#outgoingConnection?.open) {
                    this.#outgoingConnection?.send({
                        type: 'array_update',
                        key,
                        operation,
                        value,
                        updateValue
                    });
                }
                this.#handleArrayUpdate(key, operation, value, updateValue); // Optimistic update
            } catch (error) {
                console.error(ERROR_PREFIX + `Failed to send array update to host:`, error);
                this.#triggerEvent("error", `Failed to send array update to host: ${error}`);
            }
        }
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
                this.#triggerEvent("instanceDestroyed");
            }

            // Clear intervals
            clearInterval(this.#heartbeatSendInterval);

            // Resets
            this.#peer = undefined;
            this.#storage = {};
            this.#isHost = false;
            this.#hostConnections.clear();
            this.#hostConnectionsIdArray = [];
            this.#initialized = false;
            this.#maxSize = undefined;
            this.#callbacks.clear();
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
        return { ...this.#storage } || {};
    }

    /**
    *  @returns {boolean} Check if this peer is hosting
    */
    get isHost() {
        return this.#isHost;
    }

    get id() {
        return this.#id;
    }
}