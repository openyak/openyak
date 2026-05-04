# `ChatChannel` is the fast path for chat-style Channels; `VendorTransport` is the injected vendor protocol

Chat-style Channels (Feishu, WeChat, Telegram, Slack, Discord, DingTalk) share ~80% of their scaffolding — webhook dispatch, dedup, allowlist, streaming-card buffer, media pipeline, text chunking. We extract that scaffolding into `ChatChannel(BaseChannel)` with a declarative `ChatProfile` for vendor knobs (transport, edit-throttle, signature scheme). Vendor-specific behavior (authn, send, edit, parse_inbound, upload) is provided through an injected `VendorTransport` Protocol — composition, not subclassing — so each vendor can be unit-tested against a `RecordingTransport`. Email / RSS / voice and other Channels that don't fit the chat shape continue to subclass `BaseChannel` directly.

## Considered options

- **One-verb Channel transducer** (Channel = transducer between vendor `Transport` and MessageBus, single `bind()` method). Rejected: forces interactive logins (WeChat QR) and reactions/commands through the bus, which fights OpenYak's existing patterns and adds indirection without compensating leverage.
- **Six-protocol composition** (`WebhookVerifier`, `CredentialSource`, `MessageReceiver`, `MessageSender`, `DeltaRenderer`, `LifecycleHook` composed on a `Channel`). Rejected: per-protocol Depth is low, state fragments across protocols, and the flexibility budget only pays off if ≥3 unusual Channels (voice, RSS, batch email) actually ship — OpenYak's current trajectory does not support that bet.
