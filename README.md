# PlayPeer

A WebRTC wrapper that simplifies peer-to-peer multiplayer game development by abstracting away connection handling and state synchronization.

## Why use PlayPeer?

PlayPeer eliminates the traditional complexity of WebRTC multiplayer implementations:

- **Simplified Architecture**: No need for separate server/client logic
- **Automatic Host Migration**: Seamless host switching if the current host disconnects
- **State Synchronization**: Built-in storage system keeps game state synchronized across all peers
- **Resilient Connections**: Automatic reconnection handling and connection health monitoring

## Installation

```bash
npm install playpeerjs
```

## Usage

```javascript
import PlayPeer from 'playpeerjs';

// Create a new instance
const peer = new PlayPeer('unique-peer-id'); // It's recommended to pass an iceConfig here

// Set up event handlers
peer.onEvent('status', status => console.log('Status:', status));
peer.onEvent('error', error => console.error('Error:', error));
peer.onEvent('storageUpdate', storage => console.log('Storage update received:', storage));

// Initialize the peer
try {
    await peer.init();
} catch (error) {
    console.error("Peer failed to initialize:", error);
}

// Create a new room
const hostId = peer.createRoom({
    players: [],
    gameState: 'waiting',
    gameLength: 60,
});

// Or, join room
try {
    await peer.joinRoom('host-peer-id'); // Times out after 2s if connection fails
    const currentState = peer.getStorage();
    peer.updateStorage('players', [...currentState.players, newPlayer]);
} catch (error) {
    console.error('Failed to join room:', error);
}
```

## API Reference

### Constructor

```javascript
new PlayPeer(id: string, options?: PeerJS.Options)
```

Creates a new PlayPeer instance with the specified peer ID and optional [PeerJS configuration](https://peerjs.com/docs/#peer-options).

### Methods

#### Core

- `init()`: Initialize the peer connection - returns promise
- `createRoom(initialStorage?: object)`: Create a new room and become host
- `joinRoom(hostId: string)`: Join an existing room. Returns promise, rejects after 2s timeout
- `destroy()`: Clean up and destroy the peer instance

#### State Management

- `updateStorage(key: string, value: any)`: Update a value in the synchronized storage
- `onEvent(event: string, callback: Function)`: Register an event callback

##### Event types

- `status`: Connection status updates (returns status `string`)
- `error`: Error events (returns error `string`)
- `destroy`: Peer destruction event
- `storageUpdate`: Storage state changes (returns storage `object`)
- `incomingPeerConnected`: New peer connected (returns peer-id `string`)
- `incomingPeerDisconnected`: Peer disconnected (returns peer-id `string`)
- `incomingPeerError`: Peer connection error (returns peer-id `string`)
- `outgoingPeerConnected`: Connected to host (returns peer-id `string`)
- `outgoingPeerDisconnected`: Disconnected from host (returns peer-id `string`)
- `outgoingPeerError`: Host connection error (returns peer-id `string`)

### Properties

- `id`: Peer's unique identifier
- `connectionCount`: Number of active peer connections (without you)
- `getStorage`: Retrieve storage object

## License

MIT

## Contributing

Please feel free to fork the repository and submit a Pull Request.