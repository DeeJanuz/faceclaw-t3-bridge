/** Shared phone provider wire contract. Android owns notification/action authority. */
export interface PhoneApp {
  packageName: string;
  name: string;
  replyObserved: boolean;
  enabled: boolean;
}
export interface PhoneNotification {
  key: string;
  revision: string;
  packageName: string;
  appName: string;
  title: string;
  text: string;
  arrivedAt: number;
  replyable: true;
  sender?: string;
  thread?: string;
}
export interface PhoneSnapshot {
  connected: boolean;
  permissionGranted: boolean;
  apps: PhoneApp[];
  notifications: PhoneNotification[];
}
export type PhoneCommandStatus = 'handed_off' | 'dismissed' | 'failed' | 'unavailable' | 'unknown';
export interface PhoneCommandResult { id: string; status: PhoneCommandStatus }
export interface PhonePairing { code: string; expiresAt: number }

/** Immutable tap time lets both endpoints reject stale actions after receipt cleanup. */
export function createPhoneCommandId(): string {
  return `${Date.now()}-${crypto.randomUUID()}`
}
