import * as pulumi from '@pulumi/pulumi';
import * as docker from '@pulumi/docker';
import * as k8s from '@pulumi/kubernetes';


const infraConfig = new pulumi.StackReference('infra', {
  name: 'friel-pulumi-corp/tailscale-up-2023/dev',
});

const kubeconfig = infraConfig.getOutput('kubeconfig') as pulumi.Output<string>;
const clusterIP = infraConfig.getOutput('clusterIP') as pulumi.Output<string>;

const k8sProvider = new k8s.Provider('k8s-provider', {
  kubeconfig: kubeconfig,
});


/* Tailscale section */
// Step 1 install tailscale

import { tailscale } from './k8s-tailscale';

tailscale(k8sProvider, clusterIP);

// We've configured tailscale to advertise the same IP as the original public IP of the cluster

// Step 2: disconnect access

// Step 3: verify can still connect, deploy new app

// Step 4: delete pod, show that we can't connect briefly but that it comes back up

/* End tailscale */

const registryUrl = infraConfig.getOutput('registryUrl') as pulumi.Output<string>;

const imageName = registryUrl.apply((url) => `${url}/tailscale-up-awesome-app:latest`);

const image = new docker.Image('my-image', {
  imageName: imageName,
  build: {
    context: "image",
    platform: 'linux/amd64',
  },
});

const appLabels = { app: 'awesome-app' };

const namespace = new k8s.core.v1.Namespace("awesome-app");

const deployment = new k8s.apps.v1.Deployment(
  'awesome-app',
  {
    metadata: {
      namespace: namespace.metadata.name,
      labels: appLabels
    },
    spec: {
      selector: { matchLabels: appLabels },
      template: {
        metadata: { labels: appLabels },
        spec: {
          containers: [
            {
              name: 'app',
              image: imageName,
              ports: [{ containerPort: 80 }],
            },
          ],
        },
      },
    },
  },
  { provider: k8sProvider, dependsOn: [image], deletedWith: namespace },
);

const service = new k8s.core.v1.Service(
  'awesome-app',
  {
    metadata: {
      namespace: namespace.metadata.name,
      labels: appLabels
    },
    spec: {
      type: 'LoadBalancer',
      selector: appLabels,
      ports: [{ port: 80, targetPort: 80 }],
    },
  },
  { provider: k8sProvider, dependsOn: [deployment], deletedWith: namespace },
);

export const url = service.status.apply((s) => s.loadBalancer.ingress[0].ip);
