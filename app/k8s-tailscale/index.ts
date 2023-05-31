import { readFile } from 'fs/promises';
import * as path from 'path';

import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const tailscaleKey = config.requireSecret('tailscaleKey');

const tailscaleStateSecretName = 'tailscale-state';
const tailscaleLabels = {
  'app.kubernetes.io/name': 'tailscale',
};

export function tailscale(k8sProvider: k8s.Provider, clusterIP: pulumi.Output<string>) {
  const namespace = new k8s.core.v1.Namespace('tailscale-system', {
    metadata: {
      name: 'tailscale-system',
    },
  }, { provider: k8sProvider });

  const secret = new k8s.core.v1.Secret('tailscale-auth', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    stringData: {
      AUTH_KEY: tailscaleKey,
    },
  }, { provider: k8sProvider, deletedWith: namespace });

  const configMap = new k8s.core.v1.ConfigMap('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    data: {
      'run.sh': readFile(path.join(__dirname, './scripts/run.sh'), {
        encoding: 'utf-8',
      }),
    },
  }, { provider: k8sProvider, deletedWith: namespace });

  const { serviceAccount } = tailscaleRbac(k8sProvider, namespace);

  const headlessService = new k8s.core.v1.Service('tailscale', {
    metadata: {
      name: 'tailscale',
      namespace: namespace.metadata.name,
      labels: tailscaleLabels,
      annotations: {
        // Consider successful before statefulset is up.
        'pulumi.com/skipAwait': 'true',
      },
    },
    spec: {
      ports: [],
      clusterIP: 'None',
      selector: tailscaleLabels,
    },
  }, { provider: k8sProvider, deletedWith: namespace });

  new k8s.apps.v1.StatefulSet('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    spec: {
      selector: { matchLabels: tailscaleLabels },
      serviceName: headlessService.metadata.name,
      replicas: 1,
      template: {
        metadata: {
          labels: tailscaleLabels,
        },
        spec: {
          serviceAccountName: serviceAccount.metadata.name,
          initContainers: [
            {
              name: 'sysctler',
              image: 'busybox',
              securityContext: { privileged: true },
              command: ['/bin/sh'],
              args: ['-c', 'sysctl -w net.ipv4.ip_forward=1'],
              resources: {
                requests: {
                  cpu: '1m',
                  memory: '1Mi',
                },
              },
            },
          ],
          containers: [
            {
              name: 'tailscale',
              imagePullPolicy: 'Always',
              image: 'ghcr.io/tailscale/tailscale:v1.42.0',
              command: ['/bin/sh'],
              args: ['/opt/tailscale/run.sh'],
              env: [
                {
                  name: 'KUBE_SECRET',
                  value: tailscaleStateSecretName,
                },
                {
                  name: 'AUTH_KEY',
                  valueFrom: {
                    secretKeyRef: {
                      name: secret.metadata.name,
                      key: 'AUTH_KEY',
                    },
                  },
                },
                {
                  name: 'EXTRA_ARGS',
                  value: pulumi.interpolate`--hostname awesome-cluster --advertise-routes=${clusterIP}/32`,
                },
              ],
              securityContext: { capabilities: { add: ['NET_ADMIN'] } },
              volumeMounts: [
                {
                  mountPath: '/opt/tailscale',
                  name: 'scripts',
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'scripts',
              configMap: {
                defaultMode: 0o555,
                name: configMap.metadata.name,
              },
            },
          ],
        },
      },
    },
  }, { provider: k8sProvider, deletedWith: namespace });

  return {};
}

function tailscaleRbac(k8sProvider: k8s.Provider, namespace: k8s.core.v1.Namespace) {
  const serviceAccount = new k8s.core.v1.ServiceAccount('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
  }, { provider: k8sProvider, deletedWith: namespace });

  const role = new k8s.rbac.v1.Role('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    rules: [
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['create'],
      },
      {
        apiGroups: [''],
        resourceNames: [tailscaleStateSecretName],
        resources: ['secrets'],
        verbs: ['get', 'update'],
      },
    ],
  }, { provider: k8sProvider, deletedWith: namespace });

  new k8s.rbac.v1.RoleBinding('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: serviceAccount.metadata.name,
      },
    ],
    roleRef: {
      kind: 'Role',
      name: role.metadata.name,
      apiGroup: 'rbac.authorization.k8s.io',
    },
  }, { provider: k8sProvider, deletedWith: namespace });

  return { serviceAccount };
}
