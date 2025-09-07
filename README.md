> [!WARNING] 
> PlayPeer is in maintenance mode. Bugs will still be fixed, but the main focus is on [PlaySocketJS](https://github.com/therealPaulPlay/PlaySocketJS).
> WebSocket has proven to be more reliable, observable and lower latency (unless peers are in close geographical proximity).
> PlayPeerJS is mostly viable in scenarios where keeping costs low is the most important factor.

# PlayPeer

A WebRTC wrapper that simplifies peer-to-peer multiplayer game development by abstracting away connection handling and state synchronization.

## Why use PlayPeer?

PlayPeer eliminates the traditional complexity of WebRTC multiplayer implementations:

- **Simplified Architecture**: No need for separate server/client logic, inexpensive to host
- **Automatic Host Migration**: Seamless host switching if the current host disconnects
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

// Create a new room (with ptional inital storage data)
const hostId = await peer.createRoom({
    players: [],
});

// Join an existing room
await peer.joinRoom('host-peer-id'); // Rejects if connection fails or times out

// Interact with the synced storage (available if in room)
const currentState = peer.getStorage;
peer.updateStorageArray('players', 'add-unique', { username: 'PeerEnjoyer4', level: 2 }); // Special method to enable safe, simultaneous storage updates for arrays
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

- `init()`: Initialize the peer connection – Returns Promise (async) which resolves with the peer id
- `createRoom(initialStorage?: object, maxSize?: number)`: Create a new room and become host – Returns Promise (async) which resolves with the host's id
- `joinRoom(hostId: string)`: Join an existing room – Returns promise (async)
- `destroy()`: Use this to leave a room and destroy the instance

#### State management

- `updateStorage(key: string, value: any)`: Update a value in the synchronized storage
- `updateStorageArray(key: string, operation: 'add' | 'add-unique' | 'remove-matching' | 'update-matching', value: any, updateValue?: any)`: Safely update arrays in storage by adding, removing, or updating items. This is necessary for when array updates might be happening simultanously to ensure changes are being applied and not overwritten. Using add-unique instead of add ensures that this value can only be in the array once.
- `onEvent(event: string, callback: Function)`: Register an event callback

##### Event types

- `status`: Connection status updates (returns status `string`)
- `error`: Error events (returns error `string`)
- `instanceDestroyed`: Destruction event - triggered by manual .destroy() method invocation or by fatal errors
- `storageUpdated`: Storage state changes (returns storage `object`)
- `hostMigrated`: Host changes (returns host id / room code `string`)
- `incomingPeerConnected`: New peer connected (returns peer-id `string`)
- `incomingPeerDisconnected`: Peer disconnected (returns peer-id `string`)
- `incomingPeerError`: Peer connection error (returns peer-id `string`)
- `outgoingPeerConnected`: Connected to host (returns peer-id `string`)
- `outgoingPeerDisconnected`: Disconnected from host (returns peer-id `string`)
- `outgoingPeerError`: Host connection error (returns peer-id `string`)

### Properties (Read-only)

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