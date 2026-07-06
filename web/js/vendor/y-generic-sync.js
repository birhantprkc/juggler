"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const debug_1 = __importDefault(require("debug"));
const events_1 = require("events");
const decoding = __importStar(require("lib0/dist/decoding"));
const encoding = __importStar(require("lib0/dist/encoding"));
const authProtocol = __importStar(require("y-protocols/auth"));
const awarenessProtocol = __importStar(require("y-protocols/awareness"));
const syncProtocol = __importStar(require("y-protocols/sync"));
const message_types_1 = require("./message-types");
class GenericSyncProvider extends events_1.EventEmitter {
    constructor(doc, config) {
        super();
        this.doc = doc;
        this.config = config;
        this._synced = false;
        this.connected = false;
        this.callbacks = {
            onDocumentUpdate: (update, origin) => {
                if (origin !== this) {
                    this.logger("document updated locally, broadcasting update to peers");
                    this.emit("broadcast", message_types_1.createUpdateMessage(update), this.id);
                }
            },
            onAwarenessUpdate: ({ added, updated, removed }) => {
                const changedClients = added.concat(updated).concat(removed);
                const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
                this.emit("broadcast", message_types_1.createAwarenessUpdateMessage(awarenessUpdate), this.id);
            },
            removeSelfFromAwarenessOnUnload: () => {
                awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
            },
        };
        this.id = doc.clientID;
        this.logger = debug_1.default("y-" + doc.clientID);
        this.logger("initializing");
        this.awareness = this.config.awareness || new awarenessProtocol.Awareness(doc);
        this.doc.on('update', this.callbacks.onDocumentUpdate);
        this.awareness.on('update', this.callbacks.onAwarenessUpdate);
        if (this.config.resyncInterval && this.config.resyncInterval > 0) {
            this.resyncInterval = setInterval(() => {
                this.logger("resyncing (resync interval elapsed)");
                this.emit("broadcast", message_types_1.createSyncStep1Message(this.doc), this.id);
            }, this.config.resyncInterval);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', this.callbacks.removeSelfFromAwarenessOnUnload);
        }
        else if (typeof process !== 'undefined') {
            process.on('exit', () => this.callbacks.removeSelfFromAwarenessOnUnload);
        }
    }
    get synced() {
        return this._synced;
    }
    set synced(state) {
        if (this._synced !== state) {
            this.logger("setting sync state to " + state);
            this._synced = state;
            this.emit('synced', [state]);
            this.emit('sync', [state]);
        }
    }
    onConnecting() {
        if (!this.connected) {
            this.logger("connecting");
            this.emit('status', [{ status: "connecting" }]);
        }
    }
    onConnect() {
        this.logger("connected");
        this.connected = true;
        this.emit('status', [{ status: "connected" }]);
        this.emit("broadcast", message_types_1.createSyncStep1Message(this.doc), this.id);
        if (this.awareness.getLocalState() !== null) {
            const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
            this.emit("broadcast", message_types_1.createAwarenessUpdateMessage(awarenessUpdate), this.id);
        }
    }
    onDisconnect() {
        this.logger("disconnected");
        this.synced = false;
        // update awareness (keep all users except local)
        // FIXME? compare to broadcast channel behavior
        const states = Array.from(this.awareness.getStates().keys())
            .filter(client => client !== this.doc.clientID);
        awarenessProtocol.removeAwarenessStates(this.awareness, states, this);
        if (this.connected) {
            this.connected = false;
            this.emit('status', [{ status: "disconnected" }]);
        }
    }
    onMessage(message, origin) {
        if (origin === this.id) {
            return;
        }
        this.logger(`received ${message.byteLength} bytes from ${origin}`);
        const emitSynced = true;
        const decoder = decoding.createDecoder(message);
        const messageType = decoding.readVarUint(decoder);
        let response = null;
        switch (messageType) {
            case message_types_1.MessageType.MessageSync:
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, message_types_1.MessageType.MessageSync);
                const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
                this.logger(`processed message (type = MessageSync, subtype = ${syncMessageType}`);
                if (emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
                    this.synced = true;
                }
                if (encoding.length(encoder) > 1) {
                    response = encoding.toUint8Array(encoder);
                }
                break;
            case message_types_1.MessageType.MessageQueryAwareness:
                const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys()));
                response = message_types_1.createAwarenessUpdateMessage(awarenessUpdate);
                this.logger("processed message (type = MessageQeuryAwareness)");
                break;
            case message_types_1.MessageType.MessageAwareness:
                awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
                this.logger("processed message (type = MessageAwareness)");
                break;
            case message_types_1.MessageType.MessageAuth:
                authProtocol.readAuthMessage(decoder, this.doc, (provider, reason) => console.warn(`Permission denied to channel:\n${reason}`));
                this.logger("processed message (type = MessageAuth)");
                break;
            default:
                console.error('Unable to compute message');
        }
        if (response) {
            this.logger("sync protocol returned a response message to be broadcast");
            this.emit("broadcast", response, this.id);
        }
    }
    destroy() {
        this.logger("destroying");
        if (this.resyncInterval) {
            clearInterval(this.resyncInterval);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this.callbacks.removeSelfFromAwarenessOnUnload);
        }
        else if (typeof process !== 'undefined') {
            process.off('exit', () => this.callbacks.removeSelfFromAwarenessOnUnload);
        }
        this.awareness.off('update', this.callbacks.onAwarenessUpdate);
        this.doc.off('update', this.callbacks.onDocumentUpdate);
    }
}
exports.default = GenericSyncProvider;
