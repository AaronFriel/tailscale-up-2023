import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import publicIp from 'public-ip';

export = async () => {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const ipv4Ip = await publicIp.v4();

  const gkeCluster = new gcp.container.Cluster(
    'cluster',
    {
      location: 'us-west1',
      releaseChannel: { channel: 'REGULAR' },
      resourceLabels: {
        owner: "friel-and-guin",
      },
      ipAllocationPolicy: {},
      masterAuthorizedNetworksConfig: {
        cidrBlocks: [
          {
            displayName: 'local-ip',
            cidrBlock: `${ipv4Ip}/32`,
          },
          {
            displayName: 'public-internet',
            cidrBlock: `0.0.0.0/0`,
          },
          // {
          //   displayName: "office-wan-ip",
          //   cidrBlock: `192.168.1.0/24`, // fake
          // },
        ],
      },
      initialNodeCount: 1,
    },
  );

  const contextName = pulumi.interpolate`gke-${gkeCluster.name}`;

  const kubeconfig = pulumi
    .secret(
      pulumi.interpolate`
apiVersion: v1
kind: Config
clusters:
- name: gke-${contextName}
  cluster:
    server: https://${gkeCluster.endpoint}
    certificate-authority-data: ${gkeCluster.masterAuth.clusterCaCertificate}
users:
- name: gke-${contextName}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
      provideClusterInfo: true
contexts:
- context:
    cluster: gke-${contextName}
    user: gke-${contextName}
  name: gke-${contextName}
current-context: gke-${contextName}
`,
    )
    .apply((x) => x.trim());

  // Create a private GCR registry.
  const registry = new gcp.container.Registry("my-registry");
  const registryUrl = registry.id.apply(_ =>
      gcp.container.getRegistryRepository().then(reg => reg.repositoryUrl));


  return {
    name: gkeCluster.name,
    location: gkeCluster.location,
    clusterIP: gkeCluster.endpoint,
    project: gkeCluster.project,
    authorizedIp: ipv4Ip,
    kubeconfig,
    registryUrl,
  };
}
