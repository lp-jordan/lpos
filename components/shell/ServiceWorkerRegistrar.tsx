'use client';

import { useEffect } from 'react';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').then(async (registration) => {
      // Set up browser push if VAPID key is configured
      if (!VAPID_PUBLIC_KEY) return;
      if (!('PushManager' in window)) return;

      try {
        // Check existing subscription
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          // Only subscribe if user has granted (or not yet decided) permission
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') return;
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          });
        }
        // Save/refresh subscription on server
        await fetch('/api/notifications/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: subscription.endpoint,
            keys: {
              p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')!))),
              auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')!))),
            },
          }),
        });
      } catch {
        // Push subscription is a progressive enhancement — silently ignore
      }
    }).catch(() => {});
  }, []);

  return null;
}
