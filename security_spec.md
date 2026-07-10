# Security Specification & Threat Model for Zoya AI Voice Assistant

## 1. Data Invariants
- **Preference Integrity**: A user settings document at `/users/{userId}/preferences/settings` must only be readable and writable by the user whose UID matches `{userId}`.
- **Identity Integrity**: A user can only set `userId` in `UserPreference` or `ChatMessage` to their own verified `request.auth.uid`.
- **Timestamp Integrity**: `updatedAt` and `createdAt` must be set to `request.time` on write.
- **Chat History Bound**: Chat messages at `/users/{userId}/chat_history/{messageId}` must only be readable and writable by the same authenticated user `{userId}`.
- **Type Safety**: Field types must be strictly validated (e.g., `creatorName` must be string of size <= 100, `isMuted` must be a boolean).

---

## 2. The "Dirty Dozen" Payloads (Threat Vectors & Logic Exploits)
Below are 12 malicious payloads and operations that our firestore rules must block with `PERMISSION_DENIED`.

### Attack Vector Group A: Identity & Impersonation Spoofing
1. **Unauthenticated Preference Write**: Trying to create a settings document without logging in.
2. **Preference Hijacking (Wrong Owner)**: User `attacker_uid` attempts to write preferences under `/users/legit_user_uid/preferences/settings`.
3. **Impersonated Creator Name**: User `attacker_uid` writing a ChatMessage with a forged sender alias or custom `userId` field matching another user's UID.

### Attack Vector Group B: Schema & Format Poisoning (Denial of Wallet / Resource Exhaustion)
4. **Gigantic Creator Name (Denial of Wallet)**: Setting `creatorName` in settings to a 2MB string.
5. **Junk Fields Injection (Shadow Fields)**: Writing preferences with undocumented fields, e.g. `{ "userId": "uid", "creatorName": "Harikirshan", "isMuted": false, "isAdmin": true, "updatedAt": request.time }`.
6. **Mute State Type Poisoning**: Setting `isMuted` to `"not_boolean"` (a string) instead of a proper boolean.

### Attack Vector Group C: Timestamp & Temporal Integrity
7. **Client-Forced Creation Timestamp**: Trying to write `createdAt` as a pre-dated value (e.g., `2020-01-01T00:00:00Z`) to spoof session status rather than using `request.time`.
8. **Client-Forced Update Timestamp**: Trying to update settings without providing `updatedAt` equal to `request.time`.

### Attack Vector Group D: Unauthorized Cross-User Access (PII & History Leaks)
9. **Blanket Query / Read Attempt (No Owner constraint)**: An authenticated user trying to fetch chat history of ALL users without specifying their own UID.
10. **Chat Hijacking (Cross-Write)**: User `bad_uid` attempts to insert a ChatMessage directly into `/users/victim_uid/chat_history/someMsgId`.
11. **Chat Message Text Deletion**: A user attempting to delete a single chat message or the preferences of another user.
12. **Wrong Chat Message Sender enum**: Attempting to write a chat message where `sender` is `"anonymous_hacker"`.

---

## 3. Test Cases (TDD Rules Validation)

We can simulate these payloads against the Firestore emulator or inspect them in rule validators.

For Firestore Rules implementation:
All the above vectors will fail `PERMISSION_DENIED` thanks to the rules implemented below.
