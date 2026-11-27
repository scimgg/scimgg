# The sandbox's runtime image (see ../../sandbox): the pinned official node -slim image plus what
# native modules need to build from source, since their prebuilt-binary downloads have no network
# in the sandbox. PACKAGES is ./sandbox's SANDBOX_APT_PACKAGES, which a fork's local.sh can extend.
# Built by ./sandbox from this file alone (an empty context); it runs nothing from any snapshot.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG PACKAGES
RUN apt-get update \
  && apt-get install -y --no-install-recommends ${PACKAGES} \
  && rm -rf /var/lib/apt/lists/*
LABEL scimgg.sandbox=1
