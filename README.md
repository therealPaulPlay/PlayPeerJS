# PlayPeer

A WebRTC wrapper that simplifies peer-to-peer multiplayer game development by abstracting away connection handling and state synchronization.

## Why use PlayPeer?

PlayPeer eliminates the traditional complexity of WebRTC multiplayer implementations:

- **Simplified Architecture**: No need for separate server/client logic
- **Automatic Host Migration**: Seamless host switching if the current – or any future – host disconnects
- **State Synchronization**: Built-in storage system keeps game state synchronized across all peers
- **Resilient Connections**: Automatic reconnection handling and connection health monitoring

![Diagram explaining the difference](/resources/explanation.png)

## Installation

```bash
npm install playpeerjs
```

## Usage

Note that in production, you should **always try...catch** these promises, such as peer.init(), to ensure your application continues to run if errors occur.

```javascript
import PlayPeer from 'playpeerjs';

// Create a new instance
const peer = new PlayPeer('unique-peer-id', {{
    // Provide stun and turn servers here
    config: {
        'iceServers': [
            { urls: "stun:your-stun-server.com" },
            { urls: "turn:your-turn-server.com" },
        ]
    }
}});

// Set up event handlers
peer.onEvent('status', status => console.log('Status:', status));
peer.onEvent('storageUpdate', storage => console.log('Storage update received:', storage));

// Initialize the peer
await peer.init();

// Create a new room
const hostId = await peer.createRoom({
    players: [],
});

// Or, join room
await peer.joinRoom('host-peer-id'); // Rejects if connection fails or times out

// Interact with the synced storage
const currentState = peer.getStorage;
peer.updateStorageArray('players', 'add', { username: 'PeerEnjoyer4', level: 2 }); // Special method to enable simultaneous storage updates for arrays
peer.updateStorage('latestPlayer', 'PeerEnjoyer4'); // Regular synced storage update

// To leave the room, destroy the instance
peer.destroy();
```

## API Reference

### Constructor

```javascript
new PlayPeer(id: string, options?: PeerJS.Options)
```

Creates a new PlayPeer instance with a specified peer ID and [PeerJS options](https://peerjs.com/docs/#peer-options).

### Methods

#### Core

- `init()`: Initialize the peer connection (async)
- `createRoom(initialStorage?: object)`: Create a new room and become host (async)
- `joinRoom(hostId: string)`: Join an existing room. Returns promise, rejects after 2s timeout (async)
- `destroy()`: Use this to leave a room. Destroys the peer instance

#### State Management

- `updateStorage(key: string, value: any)`: Update a value in the synchronized storage
- `updateStorageArray(key: string, operation: 'add' | 'remove-matching' | 'update-matching', value: any, updateValue?: any)`: Safely update arrays in storage by adding, removing, or updating items. This is necessary for when array updates might be happening simultanously to ensure changes are being applied and not overwritten.
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

The `id` is used to distinguish the peer from other peers on the signalling server. 
Using a uuid is recommended, but it is also fine to use any other random string. If you're using a public signalling server instance, including
your application's name in the `id` can help to prevent overlap (e.g. your-app-012345abcdef). 

- `id`: Peer's unique identifier
- `isHost`: If this peer is currently hosting or not
- `connectionCount`: Number of active peer connections (without you)
- `getStorage`: Retrieve storage object

## License

MIT

## Resources
- [**What is WebRTC?**](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)

## Contributing

Please feel free to fork the repository and submit a Pull Request.