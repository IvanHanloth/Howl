import { EventEmitter } from 'events';
import Bonjour, { Service } from 'bonjour-service';
import { ServiceInfo, PeerInfo, TransferMode } from '../types';

/**
 * LAN Discovery using mDNS (Bonjour)
 * Handles service advertisement and discovery on local network
 */
export class LanDiscovery extends EventEmitter {
  private bonjour: Bonjour;
  private publishedService?: Service;
  private browser?: ReturnType<Bonjour['find']>;
  private discoveredServices: Map<string, ServiceInfo> = new Map();

  private static readonly SERVICE_TYPE = 'howl-share';
  private static readonly PROTOCOL = 'tcp';

  constructor() {
    super();
    this.bonjour = new Bonjour();
  }

  /**
   * Advertise a service on the local network
   */
  advertise(peerId: string, name: string, port: number, metadata?: Record<string, string>): void {
    if (this.publishedService) {
      this.unpublish();
    }

    const txt: Record<string, string> = {
      id: peerId,
      name,
      version: '1.0.0',
      ...metadata,
    };

    // Enhanced configuration for better cross-platform compatibility
    this.publishedService = this.bonjour.publish({
      name: `${LanDiscovery.SERVICE_TYPE}-${peerId}`,
      type: LanDiscovery.SERVICE_TYPE,
      protocol: LanDiscovery.PROTOCOL,
      port,
      txt,
      // Probe for existing services to avoid conflicts
      probe: true,
    });

    this.publishedService.on('up', () => {
      console.log(`[Discovery] Service advertised on port ${port}`);
      this.emit('advertised', { port, peerId, name });
    });

    this.publishedService.on('error', (err: Error) => {
      console.error('[Discovery] Advertisement error:', err);
      this.emit('error', err);
    });
  }

  /**
   * Start discovering services on the local network
   */
  startDiscovery(): void {
    if (this.browser) {
      this.stopDiscovery();
    }

    console.log('[Discovery] Starting service discovery...');
    // Enhanced configuration for better cross-platform discovery
    this.browser = this.bonjour.find({
      type: LanDiscovery.SERVICE_TYPE,
      protocol: LanDiscovery.PROTOCOL,
    });

    this.browser.on('up', (service: Service) => {
      const serviceInfo = this.parseService(service);
      if (serviceInfo) {
        this.discoveredServices.set(serviceInfo.id, serviceInfo);
        console.log(`[Discovery] Found service: ${serviceInfo.name} at ${serviceInfo.host}:${serviceInfo.port}`);
        this.emit('service-up', serviceInfo);
      }
    });

    this.browser.on('down', (service: Service) => {
      const serviceInfo = this.parseService(service);
      if (serviceInfo) {
        this.discoveredServices.delete(serviceInfo.id);
        console.log(`[Discovery] Service down: ${serviceInfo.name}`);
        this.emit('service-down', serviceInfo);
      }
    });

    this.browser.start();
  }

  /**
   * Stop discovering services
   */
  stopDiscovery(): void {
    if (this.browser) {
      if (typeof this.browser.stop === 'function') {
        this.browser.stop();
      }
      this.browser = undefined;
      console.log('[Discovery] Stopped service discovery');
    }
  }

  /**
   * Get all currently discovered services
   */
  getDiscoveredServices(): ServiceInfo[] {
    return Array.from(this.discoveredServices.values());
  }

  /**
   * Get discovered peers (converts services to peer info)
   */
  getDiscoveredPeers(): PeerInfo[] {
    return this.getDiscoveredServices().map(service => ({
      id: service.id,
      name: service.txt?.name || service.name,
      address: service.host,
      port: service.port,
      mode: TransferMode.LAN,
    }));
  }

  /**
   * Unpublish the advertised service
   */
  unpublish(): void {
    if (this.publishedService && typeof this.publishedService.stop === 'function') {
      this.publishedService.stop();
      this.publishedService = undefined;
      console.log('[Discovery] Service unpublished');
    }
  }

  /**
   * Cleanup all resources
   */
  destroy(): void {
    this.stopDiscovery();
    this.unpublish();
    this.discoveredServices.clear();
    this.bonjour.destroy();
    this.removeAllListeners();
  }

  /**
   * Parse Bonjour service to ServiceInfo
   */
  private parseService(service: Service): ServiceInfo | null {
    try {
      const txt = service.txt as Record<string, string> | undefined;
      const id = txt?.id || service.name;

      if (!id) {
        return null;
      }

      return {
        id,
        name: service.name,
        host: service.host || service.addresses?.[0] || 'unknown',
        port: service.port,
        txt,
      };
    } catch (error) {
      console.error('[Discovery] Failed to parse service:', error);
      return null;
    }
  }
}
