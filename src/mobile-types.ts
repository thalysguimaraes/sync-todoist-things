// Mobile-specific types for the Expo app sync endpoints

export interface MobileTask {
  id: string; // UUID v4 locally generated
  title: string;
  notes: string;
  due: string | null; // ISO string
  status: 'open' | 'completed' | 'deleted';
  list: 'inbox' | 'today' | 'upcoming' | 'someday';
  labels: string[];
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
  syncState: 'dirty' | 'synced' | 'conflict';
}

export interface DeviceRegistration {
  deviceId: string;
  secret: string;
  registeredAt: string;
  lastSeen?: string;
  platform?: string;
  appVersion?: string;
}

export interface MobileSyncRequest {
  deviceId: string;
  changes: {
    created: MobileTask[];
    updated: MobileTask[];
    completed: string[]; // Task IDs
    deleted: string[]; // Task IDs
  };
  lastSyncAt: string | null; // ISO string
  signature: string; // HMAC signature
  timestamp: string; // Request timestamp for replay protection
}

export interface MobileSyncResponse {
  success: boolean;
  conflicts?: Array<{
    mobileId: string;
    reason: string;
    serverTask?: MobileTask;
  }>;
  mappings: Array<{
    mobileId: string;
    thingsId: string;
  }>;
  serverTime: string;
  nextSyncAfter?: string; // For rate limiting
}

export interface MobileChangesResponse {
  tasks: MobileTask[];
  tombstones: string[]; // IDs of deleted tasks
  serverTime: string;
  hasMore: boolean;
}

export interface MobileTaskMapping {
  mobileId: string;
  todoistId?: string;
  thingsId?: string;
  fingerprint: string;
  deviceId: string;
  createdAt: string;
  lastSynced: string;
}
