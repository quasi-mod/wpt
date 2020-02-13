'use strict';

// This polyfill library implements the WebXR Test API as specified here:
// https://github.com/immersive-web/webxr-test-api


const default_standing = new gfx.mojom.Transform();
default_standing.matrix = [1, 0, 0, 0,
                           0, 1, 0, 0,
                           0, 0, 1, 0,
                           0, 1.65, 0, 1];
const default_stage_parameters = {
  standingTransform: default_standing,
  bounds: null
};

function getMatrixFromTransform(transform) {
  const x = transform.orientation[0];
  const y = transform.orientation[1];
  const z = transform.orientation[2];
  const w = transform.orientation[3];

  const m11 = 1.0 - 2.0 * (y * y + z * z);
  const m21 = 2.0 * (x * y + z * w);
  const m31 = 2.0 * (x * z - y * w);

  const m12 = 2.0 * (x * y - z * w);
  const m22 = 1.0 - 2.0 * (x * x + z * z);
  const m32 = 2.0 * (y * z + x * w);

  const m13 = 2.0 * (x * z + y * w);
  const m23 = 2.0 * (y * z - x * w);
  const m33 = 1.0 - 2.0 * (x * x + y * y);

  const m14 = transform.position[0];
  const m24 = transform.position[1];
  const m34 = transform.position[2];

  // Column-major linearized order is expected.
  return [m11, m21, m31, 0,
          m12, m22, m32, 0,
          m13, m23, m33, 0,
          m14, m24, m34, 1];
}

function composeGFXTransform(fakeTransformInit) {
  const transform = new gfx.mojom.Transform();
  transform.matrix = getMatrixFromTransform(fakeTransformInit);
  return transform;
}

class ChromeXRTest {
  constructor() {
    this.mockVRService_ = new MockVRService(mojo.frameInterfaces);
  }

  simulateDeviceConnection(init_params) {
    return Promise.resolve(this.mockVRService_.addRuntime(init_params));
  }

  disconnectAllDevices() {
    this.mockVRService_.removeAllRuntimes(device);
    return Promise.resolve();
  }

  simulateUserActivation(callback) {
    const button = document.createElement('button');
    button.textContent = 'click to continue test';
    button.style.display = 'block';
    button.style.fontSize = '20px';
    button.style.padding = '10px';
    button.onclick = () => {
      callback();
      document.body.removeChild(button);
    };
    document.body.appendChild(button);
    test_driver.click(button);
  }
}

// Mocking class definitions

// Mock service implements the VRService mojo interface.
class MockVRService {
  constructor() {
    this.bindingSet_ = new mojo.BindingSet(device.mojom.VRService);
    this.runtimes_ = [];

    this.interceptor_ =
        new MojoInterfaceInterceptor(device.mojom.VRService.name);
    this.interceptor_.oninterfacerequest = e =>
        this.bindingSet_.addBinding(this, e.handle);
    this.interceptor_.start();
  }

  // Test methods
  addRuntime(fakeDeviceInit) {
    const runtime = new MockRuntime(fakeDeviceInit, this);
    this.runtimes_.push(runtime);

    if (this.client_) {
      this.client_.onDeviceChanged();
    }

    return runtime;
  }

  removeAllRuntimes() {
    if (this.client_) {
      this.client_.onDeviceChanged();
    }

    this.runtimes_ = [];
  }

  removeRuntime(device) {
    const index = this.runtimes_.indexOf(device);
    if (index >= 0) {
      this.runtimes_.splice(index, 1);
      if (this.client_) {
        this.client_.onDeviceChanged();
      }
    }
  }

  setClient(client) {
    if (this.client_) {
      throw new Error("setClient should only be called once");
    }

    this.client_ = client;
  }

  requestSession(sessionOptions, was_activation) {
    const requests = [];
    // Request a session from all the runtimes.
    for (let i = 0; i < this.runtimes_.length; i++) {
      requests[i] = this.runtimes_[i].requestRuntimeSession(sessionOptions);
    }

    return Promise.all(requests).then((results) => {
      // Find and return the first successful result.
      for (let i = 0; i < results.length; i++) {
        if (results[i].session) {
          // Construct a dummy metrics recorder
          const metricsRecorderPtr = new device.mojom.XRSessionMetricsRecorderPtr();
          const metricsRecorderRequest = mojo.makeRequest(metricsRecorderPtr);
          const metricsRecorderBinding = new mojo.Binding(
              device.mojom.XRSessionMetricsRecorder, new MockXRSessionMetricsRecorder(), metricsRecorderRequest);

          const success = {
            session: results[i].session,
            metricsRecorder: metricsRecorderPtr,
          };

          return {
            result: {
              success : success,
              $tag :  0
            }
          };
        }
      }

      // If there were no successful results, returns a null session.
      return {
        result: {
          failureReason : device.mojom.RequestSessionError.NO_RUNTIME_FOUND,
          $tag :  1
        }
      };
    });
  }

  exitPresent() {
    return Promise.resolve();
  }

  supportsSession(sessionOptions) {
    const requests = [];
    // Check supports on all the runtimes.
    for (let i = 0; i < this.runtimes_.length; i++) {
      requests[i] = this.runtimes_[i].runtimeSupportsSession(sessionOptions);
    }

    return Promise.all(requests).then((results) => {
      // Find and return the first successful result.
      for (let i = 0; i < results.length; i++) {
        if (results[i].supportsSession) {
          return results[i];
        }
      }

      // If there were no successful results, returns false.
      return {supportsSession: false};
    });
  }
}

// Implements XRFrameDataProvider and XRPresentationProvider. Maintains a mock
// for XRPresentationProvider.
class MockRuntime {
  // Mapping from string feature names to the corresponding mojo types.
  // This is exposed as a member for extensibility.
  static featureToMojoMap = {
    'viewer': device.mojom.XRSessionFeature.REF_SPACE_VIEWER,
    'local': device.mojom.XRSessionFeature.REF_SPACE_LOCAL,
    'local-floor': device.mojom.XRSessionFeature.REF_SPACE_LOCAL_FLOOR,
    'bounded-floor': device.mojom.XRSessionFeature.REF_SPACE_BOUNDED_FLOOR,
    'unbounded': device.mojom.XRSessionFeature.REF_SPACE_UNBOUNDED,
    'hit-test': device.mojom.XRSessionFeature.HIT_TEST,
    'dom-overlay': device.mojom.XRSessionFeature.DOM_OVERLAY,
  };

  static sessionModeToMojoMap = {
    "inline": device.mojom.XRSessionMode.kInline,
    "immersive-vr": device.mojom.XRSessionMode.kImmersiveVr,
    "immersive-ar": device.mojom.XRSessionMode.kImmersiveAr,
  };

  constructor(fakeDeviceInit, service) {
    this.sessionClient_ = new device.mojom.XRSessionClientPtr();
    this.presentation_provider_ = new MockXRPresentationProvider();

    this.pose_ = null;
    this.next_frame_id_ = 0;
    this.bounds_ = null;
    this.send_mojo_space_reset_ = false;

    this.service_ = service;

    this.framesOfReference = {};

    this.input_sources_ = new Map();
    this.next_input_source_index_ = 1;

    // Currently active hit test subscriptons.
    this.hitTestSubscriptions_ = new Map();
    // ID of the next subscription to be assigned.
    this.next_hit_test_id_ = 1;

    let supportedModes = [];
    if (fakeDeviceInit.supportedModes) {
      supportedModes = fakeDeviceInit.supportedModes.slice();
      if (fakeDeviceInit.supportedModes.length === 0) {
        supportedModes = ["inline"];
      }
    } else {
      // Back-compat mode.
      console.warn("Please use `supportedModes` to signal which modes are supported by this device.");
      if (fakeDeviceInit.supportsImmersive == null) {
        throw new TypeError("'supportsImmersive' must be set");
      }

      supportedModes = ["inline"];
      if (fakeDeviceInit.supportsImmersive) {
        supportedModes.push("immersive-vr");
      }
    }

    this.supportedModes_ = this._convertModesToEnum(supportedModes);

    // Initialize DisplayInfo first to set the defaults, then override with
    // anything from the deviceInit
    if (this.supportedModes_.includes(device.mojom.XRSessionMode.kImmersiveVr)
     || this.supportedModes_.includes(device.mojom.XRSessionMode.kImmersiveAr)) {
      this.displayInfo_ = this.getImmersiveDisplayInfo();
    } else if (this.supportedModes_.includes(device.mojom.XRSessionMode.kInline)) {
      this.displayInfo_ = this.getNonImmersiveDisplayInfo();
    } else {
      // This should never happen!
      console.error("Device has empty supported modes array!");
      throw new InvalidStateError();
    }

    if (fakeDeviceInit.viewerOrigin != null) {
      this.setViewerOrigin(fakeDeviceInit.viewerOrigin);
    }

    if (fakeDeviceInit.floorOrigin != null) {
      this.setFloorOrigin(fakeDeviceInit.floorOrigin);
    }

    if (fakeDeviceInit.world) {
      this.world_ = fakeDeviceInit.world;
    }

    // This appropriately handles if the coordinates are null
    this.setBoundsGeometry(fakeDeviceInit.boundsCoordinates);

    this.setViews(fakeDeviceInit.views);

    // Need to support webVR which doesn't have a notion of features
    this.setFeatures(fakeDeviceInit.supportedFeatures || []);
  }

  _convertModeToEnum(sessionMode) {
    if (sessionMode in MockRuntime.sessionModeToMojoMap) {
      return MockRuntime.sessionModeToMojoMap[sessionMode];
    }

    throw new TypeError("Unrecognized value for XRSessionMode enum: " + sessionMode);
  }

  _convertModesToEnum(sessionModes) {
    return sessionModes.map(mode => this._convertModeToEnum(mode));
  }

  // Test API methods.
  disconnect() {
    this.service_.removeRuntime(this);
    this.presentation_provider_.Close();
    if (this.sessionClient_.ptr.isBound()) {
      this.sessionClient_.ptr.reset();
    }

    return Promise.resolve();
  }

  setViews(views) {
    if (views) {
      let changed = false;
      for (let i = 0; i < views.length; i++) {
        if (views[i].eye == 'left') {
          this.displayInfo_.leftEye = this.getEye(views[i]);
          changed = true;
        } else if (views[i].eye == 'right') {
          this.displayInfo_.rightEye = this.getEye(views[i]);
          changed = true;
        }
      }

      if (changed && this.sessionClient_.ptr.isBound()) {
        this.sessionClient_.onChanged(this.displayInfo_);
      }
    }
  }

  setViewerOrigin(origin, emulatedPosition = false) {
    const p = origin.position;
    const q = origin.orientation;
    this.pose_ = {
      orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
      position: { x: p[0], y: p[1], z: p[2] },
      emulatedPosition: emulatedPosition,
      angularVelocity: null,
      linearVelocity: null,
      angularAcceleration: null,
      linearAcceleration: null,
      inputState: null,
      poseIndex: 0
    };
  }

  clearViewerOrigin() {
    this.pose_ = null;
  }

  simulateVisibilityChange(visibilityState) {
    let mojoState = null;
    switch (visibilityState) {
      case "visible":
        mojoState = device.mojom.XRVisibilityState.VISIBLE;
        break;
      case "visible-blurred":
        mojoState = device.mojom.XRVisibilityState.VISIBLE_BLURRED;
        break;
      case "hidden":
        mojoState = device.mojom.XRVisibilityState.HIDDEN;
        break;
    }
    if (mojoState) {
      this.sessionClient_.onVisibilityStateChanged(mojoState);
    }
  }

  setBoundsGeometry(bounds) {
    if (bounds == null) {
      this.bounds_ = null;
    } else if (bounds.length < 3) {
      throw new Error("Bounds must have a length of at least 3");
    } else {
      this.bounds_ = bounds;
    }

    // We can only set bounds if we have stageParameters set; otherwise, we
    // don't know the transform from local space to bounds space.
    // We'll cache the bounds so that they can be set in the future if the
    // floorLevel transform is set, but we won't update them just yet.
    if (this.displayInfo_.stageParameters) {
      this.displayInfo_.stageParameters.bounds = this.bounds_;

      if (this.sessionClient_.ptr.isBound()) {
        this.sessionClient_.onChanged(this.displayInfo_);
      }
    }
  }

  setFloorOrigin(floorOrigin) {
    if (!this.displayInfo_.stageParameters) {
      this.displayInfo_.stageParameters = default_stage_parameters;
      this.displayInfo_.stageParameters.bounds = this.bounds_;
    }

    this.displayInfo_.stageParameters.standingTransform = new gfx.mojom.Transform();
    this.displayInfo_.stageParameters.standingTransform.matrix =
      getMatrixFromTransform(floorOrigin);

    if (this.sessionClient_.ptr.isBound()) {
      this.sessionClient_.onChanged(this.displayInfo_);
    }
  }

  clearFloorOrigin() {
    if (this.displayInfo_.stageParameters) {
      this.displayInfo_.stageParameters = null;

      if (this.sessionClient_.ptr.isBound()) {
        this.sessionClient_.onChanged(this.displayInfo_);
      }
    }
  }

  simulateResetPose() {
    this.send_mojo_space_reset_ = true;
  }

  simulateInputSourceConnection(fakeInputSourceInit) {
    const index = this.next_input_source_index_;
    this.next_input_source_index_++;

    const source = new MockXRInputSource(fakeInputSourceInit, index, this);
    this.input_sources_.set(index, source);
    return source;
  }

  // Helper methods
  getNonImmersiveDisplayInfo() {
    const displayInfo = this.getImmersiveDisplayInfo();

    displayInfo.capabilities.canPresent = false;
    displayInfo.leftEye = null;
    displayInfo.rightEye = null;

    return displayInfo;
  }

  // Function to generate some valid display information for the device.
  getImmersiveDisplayInfo() {
    return {
      displayName: 'FakeDevice',
      capabilities: {
        hasPosition: false,
        hasExternalDisplay: false,
        canPresent: true,
        maxLayers: 1
      },
      stageParameters: null,
      leftEye: {
        fieldOfView: {
          upDegrees: 48.316,
          downDegrees: 50.099,
          leftDegrees: 50.899,
          rightDegrees: 35.197
        },
        headFromEye: composeGFXTransform({
          position: [-0.032, 0, 0],
          orientation: [0, 0, 0, 1]
        }),
        renderWidth: 20,
        renderHeight: 20
      },
      rightEye: {
        fieldOfView: {
          upDegrees: 48.316,
          downDegrees: 50.099,
          leftDegrees: 50.899,
          rightDegrees: 35.197
        },
        headFromEye: composeGFXTransform({
          position: [0.032, 0, 0],
          orientation: [0, 0, 0, 1]
        }),
        renderWidth: 20,
        renderHeight: 20
      },
      webxrDefaultFramebufferScale: 0.7,
    };
  }

  // This function converts between the matrix provided by the WebXR test API
  // and the internal data representation.
  getEye(fakeXRViewInit) {
    let fov = null;

    if (fakeXRViewInit.fieldOfView) {
      fov = {
        upDegrees: fakeXRViewInit.fieldOfView.upDegrees,
        downDegrees: fakeXRViewInit.fieldOfView.downDegrees,
        leftDegrees: fakeXRViewInit.fieldOfView.leftDegrees,
        rightDegrees: fakeXRViewInit.fieldOfView.rightDegrees
      };
    } else {
      const m = fakeXRViewInit.projectionMatrix;

      function toDegrees(tan) {
        return Math.atan(tan) * 180 / Math.PI;
      }

      const leftTan = (1 - m[8]) / m[0];
      const rightTan = (1 + m[8]) / m[0];
      const upTan = (1 + m[9]) / m[5];
      const downTan = (1 - m[9]) / m[5];

      fov = {
        upDegrees: toDegrees(upTan),
        downDegrees: toDegrees(downTan),
        leftDegrees: toDegrees(leftTan),
        rightDegrees: toDegrees(rightTan)
      };
    }

    return {
      fieldOfView: fov,
      headFromEye: composeGFXTransform(fakeXRViewInit.viewOffset),
      renderWidth: fakeXRViewInit.resolution.width,
      renderHeight: fakeXRViewInit.resolution.height
    };
  }

  setFeatures(supportedFeatures) {
    function convertFeatureToMojom(feature) {
      if (feature in MockRuntime.featureToMojoMap) {
        return MockRuntime.featureToMojoMap[feature];
      } else {
        return device.mojom.XRSessionFeature.INVALID;
      }
    }

    this.supportedFeatures_ = [];

    for (let i = 0; i < supportedFeatures.length; i++) {
      const feature = convertFeatureToMojom(supportedFeatures[i]);
      if (feature !== device.mojom.XRSessionFeature.INVALID) {
        this.supportedFeatures_.push(feature);
      }
    }
  }

  // These methods are intended to be used by MockXRInputSource only.
  addInputSource(source) {
    if (!this.input_sources_.has(source.source_id_)) {
      this.input_sources_.set(source.source_id_, source);
    }
  }

  removeInputSource(source) {
    this.input_sources_.delete(source.source_id_);
  }

  // Extension point for non-standard modules.

  _injectAdditionalFrameData(options, frameData) {
  }

  // Mojo function implementations.

  // XRFrameDataProvider implementation.
  getFrameData(options) {
    const mojo_space_reset = this.send_mojo_space_reset_;
    this.send_mojo_space_reset_ = false;
    if (this.pose_) {
      this.pose_.poseIndex++;
    }

    // Setting the input_state to null tests a slightly different path than
    // the browser tests where if the last input source is removed, the device
    // code always sends up an empty array, but it's also valid mojom to send
    // up a null array.
    let input_state = null;
    if (this.input_sources_.size > 0) {
      input_state = [];
      for (const input_source of this.input_sources_.values()) {
        input_state.push(input_source.getInputSourceState());
      }
    }

    // Convert current document time to monotonic time.
    let now = window.performance.now() / 1000.0;
    const diff = now - internals.monotonicTimeToZeroBasedDocumentTime(now);
    now += diff;
    now *= 1000000;

    const frameData = {
      pose: this.pose_,
      mojoSpaceReset: mojo_space_reset,
      inputState: input_state,
      timeDelta: {
        microseconds: now,
      },
      frameId: this.next_frame_id_++,
      bufferHolder: null,
      bufferSize: {},
    };

    this._calculateHitTestResults(frameData);

    this._injectAdditionalFrameData(options, frameData);

    return Promise.resolve({
      frameData: frameData,
    });
  }

  getEnvironmentIntegrationProvider(environmentProviderRequest) {
    this.environmentProviderBinding_ = new mojo.AssociatedBinding(
        device.mojom.XREnvironmentIntegrationProvider, this,
        environmentProviderRequest);
  }

  // Note that if getEnvironmentProvider hasn't finished running yet this will
  // be undefined. It's recommended that you allow a successful task to post
  // first before attempting to close.
  closeEnvironmentIntegrationProvider() {
    this.environmentProviderBinding_.close();
  }

  closeDataProvider() {
    this.dataProviderBinding_.close();
  }

  updateSessionGeometry(frame_size, display_rotation) {
    // This function must exist to ensure that calls to it do not crash, but we
    // do not have any use for this data at present.
  }

  // XREnvironmentIntegrationProvider implementation:
  subscribeToHitTest(nativeOriginInformation, entityTypes, ray) {
    if (!this.supportedModes_.includes(device.mojom.XRSessionMode.kImmersiveAr)) {
      // Reject outside of AR.
      return Promise.resolve({
        result : device.mojom.SubscribeToHitTestResult.FAILED,
        subscriptionId : 0
      });
    }

    if (nativeOriginInformation.$tag == device.mojom.XRNativeOriginInformation.Tags.inputSourceId) {
      if (!this.input_sources_.has(nativeOriginInformation.inputSourceId)) {
        // Reject - unknown input source ID.
        return Promise.resolve({
          result : device.mojom.SubscribeToHitTestResult.FAILED,
          subscriptionId : 0
        });
      }
    } else if (nativeOriginInformation.$tag == device.mojom.XRNativeOriginInformation.Tags.referenceSpaceCategory) {
      // Bounded_floor & unbounded ref spaces are not yet supported for AR:
      if (nativeOriginInformation.referenceSpaceCategory == device.mojom.XRReferenceSpaceCategory.UNBOUNDED
       || nativeOriginInformation.referenceSpaceCategory == device.mojom.XRReferenceSpaceCategory.BOUNDED_FLOOR) {
        return Promise.resolve({
          result : device.mojom.SubscribeToHitTestResult.FAILED,
          subscriptionId : 0
        });
      }
    } else {
      // Planes and anchors are not yet supported by the mock interface.
      return Promise.resolve({
        result : device.mojom.SubscribeToHitTestResult.FAILED,
        subscriptionId : 0
      });
    }

    // Store the subscription information as-is:
    const id = this.next_hit_test_id_++;
    this.hitTestSubscriptions_.set(id, { nativeOriginInformation, entityTypes, ray });

    return Promise.resolve({
      result : device.mojom.SubscribeToHitTestResult.SUCCESS,
      subscriptionId : id
    });
  }

  // Utility function
  requestRuntimeSession(sessionOptions) {
    return this.runtimeSupportsSession(sessionOptions).then((result) => {
      // The JavaScript bindings convert c_style_names to camelCase names.
      const options = new device.mojom.XRPresentationTransportOptions();
      options.transportMethod =
          device.mojom.XRPresentationTransportMethod.SUBMIT_AS_MAILBOX_HOLDER;
      options.waitForTransferNotification = true;
      options.waitForRenderNotification = true;

      let submit_frame_sink;
      if (result.supportsSession) {
        submit_frame_sink = {
          clientReceiver: this.presentation_provider_.getClientReceiver(),
          provider: this.presentation_provider_.bindProvider(sessionOptions),
          transportOptions: options
        };

        const dataProviderPtr = new device.mojom.XRFrameDataProviderPtr();
        const dataProviderRequest = mojo.makeRequest(dataProviderPtr);
        this.dataProviderBinding_ = new mojo.Binding(
            device.mojom.XRFrameDataProvider, this, dataProviderRequest);

        const clientReceiver = mojo.makeRequest(this.sessionClient_);

        const enabled_features = [];
        for (let i = 0; i < sessionOptions.requiredFeatures.length; i++) {
          if (this.supportedFeatures_.indexOf(sessionOptions.requiredFeatures[i]) !== -1) {
            enabled_features.push(sessionOptions.requiredFeatures[i]);
          } else {
            return Promise.resolve({session: null});
          }
        }

        for (let i =0; i < sessionOptions.optionalFeatures.length; i++) {
          if (this.supportedFeatures_.indexOf(sessionOptions.optionalFeatures[i]) !== -1) {
            enabled_features.push(sessionOptions.optionalFeatures[i]);
          }
        }

        return Promise.resolve({
          session: {
            submitFrameSink: submit_frame_sink,
            dataProvider: dataProviderPtr,
            clientReceiver: clientReceiver,
            displayInfo: this.displayInfo_,
            enabledFeatures: enabled_features,
          }
        });
      } else {
        return Promise.resolve({session: null});
      }
    });
  }

  runtimeSupportsSession(options) {
    return Promise.resolve({
      supportsSession: this.supportedModes_.includes(options.mode)
    });
  }

  // Private functions - hit test implementation:

  // Modifies passed in frameData to add hit test results.
  _calculateHitTestResults(frameData) {
    if (!this.supportedModes_.includes(device.mojom.XRSessionMode.kImmersiveAr)) {
      return;
    }

    frameData.hitTestSubscriptionResults = new device.mojom.XRHitTestSubscriptionResultsData();
    frameData.hitTestSubscriptionResults.results = [];
    frameData.hitTestSubscriptionResults.transientInputResults = [];

    if (!this.world_) {
      return;
    }

    // Non-transient hit test:
    for (const [id, subscription] of this.hitTestSubscriptions_) {
      const mojo_from_native_origin = this._getMojoFromNativeOrigin(subscription.nativeOriginInformation);
      if (!mojo_from_native_origin) continue;

      const ray_origin = {x: subscription.ray.origin.x, y: subscription.ray.origin.y, z: subscription.ray.origin.z, w: 1};
      const ray_direction = {x: subscription.ray.direction.x, y: subscription.ray.direction.y, z: subscription.ray.direction.z, w: 0};

      const mojo_ray_origin = XRMathHelper.transform_by_matrix(mojo_from_native_origin, ray_origin);
      const mojo_ray_direction = XRMathHelper.transform_by_matrix(mojo_from_native_origin, ray_direction);

      const results = this._hitTestWorld(mojo_ray_origin, mojo_ray_direction, subscription.entityTypes);

      const result = new device.mojom.XRHitTestSubscriptionResultData();
      result.subscriptionId = id;
      result.hitTestResults = results;

      frameData.hitTestSubscriptionResults.results.push(result);
    }
  }

  // Hit tests the passed in ray (expressed as origin and direction) against the mocked world data.
  _hitTestWorld(origin, direction, entityTypes) {
    let result = [];

    for (const region of this.world_.hitTestRegions) {
      const partial_result = this._hitTestRegion(
        region,
        origin, direction,
        entityTypes);

      result = result.concat(partial_result);
    }

    return result.sort((lhs, rhs) => lhs.distance - rhs.distance);
  }

  // Hit tests the passed in ray (expressed as origin and direction) against world region.
  // |entityTypes| is a set of FakeXRRegionTypes.
  // |region| is FakeXRRegion.
  // Returns array of XRHitResults, each entry will be decorated with the distance from the ray origin (along the ray).
  _hitTestRegion(region, origin, direction, entityTypes) {
    const regionNameToMojoEnum = {
      "point":device.mojom.EntityTypeForHitTest.POINT,
      "plane":device.mojom.EntityTypeForHitTest.PLANE,
      "mesh":null
    };

    if (!entityTypes.includes(regionNameToMojoEnum[region.type])) {
      return [];
    }

    const result = [];
    for (const face of region.faces) {
      const maybe_hit = this._hitTestFace(face, origin, direction);
      if (maybe_hit) {
        result.push(maybe_hit);
      }
    }

    // The results should be sorted by distance and there should be no 2 entries with
    // the same distance from ray origin - that would mean they are the same point.
    // This situation is possible when a ray intersects the region through an edge shared
    // by 2 faces.
    return result.sort((lhs, rhs) => lhs.distance - rhs.distance)
                 .filter((val, index, array) => index === 0 || val.distance !== array[index - 1].distance);
  }

  // Hit tests the passed in ray (expressed as origin and direction) against a single face.
  // |face|, |origin|, and |direction| are specified in world (aka mojo) coordinates.
  // |face| is an array of DOMPointInits.
  // Returns null if the face does not intersect with the ray, otherwise the result is
  // an XRHitResult with matrix describing the pose of the intersection point.
  _hitTestFace(face, origin, direction) {
    const add = XRMathHelper.add;
    const sub = XRMathHelper.sub;
    const mul = XRMathHelper.mul;
    const normalize = XRMathHelper.normalize;
    const dot = XRMathHelper.dot;
    const cross = XRMathHelper.cross;
    const neg = XRMathHelper.neg;

    //1. Calculate plane normal in world coordinates.
    const point_A = face[0];
    const point_B = face[1];
    const point_C = face[2];

    const edge_AB = sub(point_B, point_A);
    const edge_AC = sub(point_C, point_A);

    const normal = normalize(cross(edge_AB, edge_AC));

    const numerator = dot(sub(point_A, origin), normal);
    const denominator = dot(direction, normal);

    if (Math.abs(denominator) < 0.0001) {
      // Planes are nearly parallel - there's either infinitely many intersection points or 0.
      // Both cases signify a "no hit" for us.
      return null;
    } else {
      // Single intersection point between the infinite plane and the line (*not* ray).
      // Need to calculate the hit test matrix taking into account the face vertices.
      const distance = numerator / denominator;
      if (distance < 0) {
        // Line - plane intersection exists, but not the half-line - plane does not.
        return null;
      } else {
        const intersection_point = add(origin, mul(distance, direction));
        // Since we are treating the face as a solid, flip the normal so that its
        // half-space will contain the ray origin.
        const y_axis = denominator > 0 ? neg(normal) : normal;

        let z_axis = null;
        const cos_direction_and_y_axis = dot(direction, y_axis);
        if (Math.abs(cos_direction_and_y_axis) > 0.9999) {
          // Ray and the hit test normal are co-linear - try using the 'up' or 'right' vector's projection on the face plane as the Z axis.
          // Note: this edge case is currently not covered by the spec.
          const up = {x: 0.0, y: 1.0, z: 0.0, w: 0.0};
          const right = {x:1.0, y: 0.0, z: 0.0, w: 0.0};

          z_axis = Math.abs(dot(up, y_axis)) > 0.9999
                        ? sub(up, mul(dot(right, y_axis), y_axis))  // `up is also co-linear with hit test normal, use `right`
                        : sub(up, mul(dot(up, y_axis), y_axis));    // `up` is not co-linear with hit test normal, use it
        } else {
          // Project the ray direction onto the plane, negate it and use as a Z axis.
          z_axis = neg(sub(direction, mul(cos_direction_and_y_axis, y_axis))); // Z should point towards the ray origin, not away.
        }

        const x_axis = normalize(cross(y_axis, z_axis));

        // Filter out the points not in polygon.
        if (!XRMathHelper.pointInFace(intersection_point, face)) {
          return null;
        }

        const hitResult = new device.mojom.XRHitResult();
        hitResult.hitMatrix = new gfx.mojom.Transform();

        hitResult.distance = distance;  // Extend the object with additional information used by higher layers.
                                        // It will not be serialized over mojom.

        hitResult.hitMatrix.matrix = new Array(16);

        hitResult.hitMatrix.matrix[0] = x_axis.x;
        hitResult.hitMatrix.matrix[1] = x_axis.y;
        hitResult.hitMatrix.matrix[2] = x_axis.z;
        hitResult.hitMatrix.matrix[3] = 0;

        hitResult.hitMatrix.matrix[4] = y_axis.x;
        hitResult.hitMatrix.matrix[5] = y_axis.y;
        hitResult.hitMatrix.matrix[6] = y_axis.z;
        hitResult.hitMatrix.matrix[7] = 0;

        hitResult.hitMatrix.matrix[8] = z_axis.x;
        hitResult.hitMatrix.matrix[9] = z_axis.y;
        hitResult.hitMatrix.matrix[10] = z_axis.z;
        hitResult.hitMatrix.matrix[11] = 0;

        hitResult.hitMatrix.matrix[12] = intersection_point.x;
        hitResult.hitMatrix.matrix[13] = intersection_point.y;
        hitResult.hitMatrix.matrix[14] = intersection_point.z;
        hitResult.hitMatrix.matrix[15] = 1;

        return hitResult;
      }
    }
  }

  _getMojoFromNativeOrigin(nativeOriginInformation) {
    const identity = function() {
      return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
      ];
    };

    if (nativeOriginInformation.$tag == device.mojom.XRNativeOriginInformation.Tags.inputSourceId) {
      if (!this.input_sources_.has(nativeOriginInformation.inputSourceId)) {
        return null;
      } else {
        const inputSource = this.input_sources_.get(nativeOriginInformation.inputSourceId);
        return inputSource.mojo_from_input_.matrix;
      }
    } else if (nativeOriginInformation.$tag == device.mojom.XRNativeOriginInformation.Tags.referenceSpaceCategory) {
      switch (nativeOriginInformation.referenceSpaceCategory) {
        case device.mojom.XRReferenceSpaceCategory.LOCAL:
          return identity();
        case device.mojom.XRReferenceSpaceCategory.LOCAL_FLOOR:
          if (this.displayInfo_ == null || this.displayInfo_.stageParameters == null
           || this.displayInfo_.stageParameters.standingTransform == null) {
            console.warn("Standing transform not available.");
            return null;
          }
          // this.displayInfo_.stageParameters.standingTransform = floor_from_mojo aka native_origin_from_mojo
          return XRMathHelper.inverse(this.displayInfo_.stageParameters.standingTransform.matrix);
        case device.mojom.XRReferenceSpaceCategory.VIEWER:
          const transform = {
            position: [
              this.pose_.position.x,
              this.pose_.position.y,
              this.pose_.position.z],
            orientation: [
              this.pose_.orientation.x,
              this.pose_.orientation.y,
              this.pose_.orientation.z,
              this.pose_.orientation.w],
          };
          return getMatrixFromTransform(transform);  // this.pose_ = mojo_from_viewer
        case device.mojom.XRReferenceSpaceCategory.BOUNDED_FLOOR:
          return null;
        case device.mojom.XRReferenceSpaceCategory.UNBOUNDED:
          return null;
        default:
          throw new TypeError("Unrecognized XRReferenceSpaceCategory!");
      }
    } else {
      // Anchors & planes are not yet supported for hit test.
      return null;
    }
  }
}

class MockXRSessionMetricsRecorder {
  reportFeatureUsed(feature) {
    // Do nothing
  }
}

class MockXRInputSource {
  constructor(fakeInputSourceInit, id, pairedDevice) {
    this.source_id_ = id;
    this.pairedDevice_ = pairedDevice;
    this.handedness_ = fakeInputSourceInit.handedness;
    this.target_ray_mode_ = fakeInputSourceInit.targetRayMode;
    this.setPointerOrigin(fakeInputSourceInit.pointerOrigin);
    this.setProfiles(fakeInputSourceInit.profiles);

    this.primary_input_pressed_ = false;
    if (fakeInputSourceInit.selectionStarted != null) {
      this.primary_input_pressed_ = fakeInputSourceInit.selectionStarted;
    }

    this.primary_input_clicked_ = false;
    if (fakeInputSourceInit.selectionClicked != null) {
      this.primary_input_clicked_ = fakeInputSourceInit.selectionClicked;
    }

    this.primary_squeeze_pressed_ = false;
    this.primary_squeeze_clicked_ = false;

    this.mojo_from_input_ = null;
    if (fakeInputSourceInit.gripOrigin != null) {
      this.setGripOrigin(fakeInputSourceInit.gripOrigin);
    }

    // This properly handles if supportedButtons were not specified.
    this.setSupportedButtons(fakeInputSourceInit.supportedButtons);

    this.emulated_position_ = false;
    this.desc_dirty_ = true;
  }

  // Webxr-test-api
  setHandedness(handedness) {
    if (this.handedness_ != handedness) {
      this.desc_dirty_ = true;
      this.handedness_ = handedness;
    }
  }

  setTargetRayMode(targetRayMode) {
    if (this.target_ray_mode_ != targetRayMode) {
      this.desc_dirty_ = true;
      this.target_ray_mode_ = targetRayMode;
    }
  }

  setProfiles(profiles) {
    this.desc_dirty_ = true;
    this.profiles_ = profiles;
  }

  setGripOrigin(transform, emulatedPosition = false) {
    // grip_origin was renamed to mojo_from_input in mojo
    this.mojo_from_input_ = new gfx.mojom.Transform();
    this.mojo_from_input_.matrix = getMatrixFromTransform(transform);
    this.emulated_position_ = emulatedPosition;
  }

  clearGripOrigin() {
    // grip_origin was renamed to mojo_from_input in mojo
    if (this.mojo_from_input_ != null) {
      this.mojo_from_input_ = null;
      this.emulated_position_ = false;
    }
  }

  setPointerOrigin(transform, emulatedPosition = false) {
    // pointer_origin was renamed to input_from_pointer in mojo
    this.desc_dirty_ = true;
    this.input_from_pointer_ = new gfx.mojom.Transform();
    this.input_from_pointer_.matrix = getMatrixFromTransform(transform);
    this.emulated_position_ = emulatedPosition;
  }

  disconnect() {
    this.pairedDevice_.removeInputSource(this);
  }

  reconnect() {
    this.pairedDevice_.addInputSource(this);
  }

  startSelection() {
    this.primary_input_pressed_ = true;
    if (this.gamepad_) {
      this.gamepad_.buttons[0].pressed = true;
      this.gamepad_.buttons[0].touched = true;
    }
  }

  endSelection() {
    if (!this.primary_input_pressed_) {
      throw new Error("Attempted to end selection which was not started");
    }

    this.primary_input_pressed_ = false;
    this.primary_input_clicked_ = true;

    if (this.gamepad_) {
      this.gamepad_.buttons[0].pressed = false;
      this.gamepad_.buttons[0].touched = false;
    }
  }

  simulateSelect() {
    this.primary_input_clicked_ = true;
  }

  setSupportedButtons(supportedButtons) {
    this.gamepad_ = null;
    this.supported_buttons_ = [];

    // If there are no supported buttons, we can stop now.
    if (supportedButtons == null || supportedButtons.length < 1) {
      return;
    }

    const supported_button_map = {};
    this.gamepad_ = this.getEmptyGamepad();
    for (let i = 0; i < supportedButtons.length; i++) {
      const buttonType = supportedButtons[i].buttonType;
      this.supported_buttons_.push(buttonType);
      supported_button_map[buttonType] = supportedButtons[i];
    }

    // Let's start by building the button state in order of priority:
    // Primary button is index 0.
    this.gamepad_.buttons.push({
      pressed: this.primary_input_pressed_,
      touched: this.primary_input_pressed_,
      value: this.primary_input_pressed_ ? 1.0 : 0.0
    });

    // Now add the rest of our buttons
    this.addGamepadButton(supported_button_map['grip']);
    this.addGamepadButton(supported_button_map['touchpad']);
    this.addGamepadButton(supported_button_map['thumbstick']);
    this.addGamepadButton(supported_button_map['optional-button']);
    this.addGamepadButton(supported_button_map['optional-thumbstick']);

    // Finally, back-fill placeholder buttons/axes
    for (let i = 0; i < this.gamepad_.buttons.length; i++) {
      if (this.gamepad_.buttons[i] == null) {
        this.gamepad_.buttons[i] = {
          pressed: false,
          touched: false,
          value: 0
        };
      }
    }

    for (let i=0; i < this.gamepad_.axes.length; i++) {
      if (this.gamepad_.axes[i] == null) {
        this.gamepad_.axes[i] = 0;
      }
    }
  }

  updateButtonState(buttonState) {
    if (this.supported_buttons_.indexOf(buttonState.buttonType) == -1) {
      throw new Error("Tried to update state on an unsupported button");
    }

    const buttonIndex = this.getButtonIndex(buttonState.buttonType);
    const axesStartIndex = this.getAxesStartIndex(buttonState.buttonType);

    if (buttonIndex == -1) {
      throw new Error("Unknown Button Type!");
    }

    // is this a 'squeeze' button?
    if (buttonIndex === this.getButtonIndex('grip')) {
      // squeeze
      if (buttonState.pressed) {
        this.primary_squeeze_pressed_ = true;
      } else if (this.gamepad_.buttons[buttonIndex].pressed) {
        this.primary_squeeze_clicked_ = true;
        this.primary_squeeze_pressed_ = false;
      } else {
        this.primary_squeeze_clicked_ = false;
        this.primary_squeeze_pressed_ = false;
      }
    }

    this.gamepad_.buttons[buttonIndex].pressed = buttonState.pressed;
    this.gamepad_.buttons[buttonIndex].touched = buttonState.touched;
    this.gamepad_.buttons[buttonIndex].value = buttonState.pressedValue;

    if (axesStartIndex != -1) {
      this.gamepad_.axes[axesStartIndex] = buttonState.xValue == null ? 0.0 : buttonState.xValue;
      this.gamepad_.axes[axesStartIndex + 1] = buttonState.yValue == null ? 0.0 : buttonState.yValue;
    }
  }

  // Helpers for Mojom
  getInputSourceState() {
    const input_state = new device.mojom.XRInputSourceState();

    input_state.sourceId = this.source_id_;

    input_state.primaryInputPressed = this.primary_input_pressed_;
    input_state.primaryInputClicked = this.primary_input_clicked_;

    input_state.primarySqueezePressed = this.primary_squeeze_pressed_;
    input_state.primarySqueezeClicked = this.primary_squeeze_clicked_;
    // Setting the input source's "clicked" state should generate one "select"
    // event. Reset the input value to prevent it from continuously generating
    // events.
    this.primary_input_clicked_ = false;
    // Setting the input source's "clicked" state should generate one "squeeze"
    // event. Reset the input value to prevent it from continuously generating
    // events.
    this.primary_squeeze_clicked_ = false;

    input_state.mojoFromInput = this.mojo_from_input_;

    input_state.gamepad = this.gamepad_;

    input_state.emulatedPosition = this.emulated_position_;

    if (this.desc_dirty_) {
      const input_desc = new device.mojom.XRInputSourceDescription();

      switch (this.target_ray_mode_) {
        case 'gaze':
          input_desc.targetRayMode = device.mojom.XRTargetRayMode.GAZING;
          break;
        case 'tracked-pointer':
          input_desc.targetRayMode = device.mojom.XRTargetRayMode.POINTING;
          break;
        case 'screen':
          input_desc.targetRayMode = device.mojom.XRTargetRayMode.TAPPING;
          break;
        default:
          throw new Error('Unhandled target ray mode ' + this.target_ray_mode_);
      }

      switch (this.handedness_) {
        case 'left':
          input_desc.handedness = device.mojom.XRHandedness.LEFT;
          break;
        case 'right':
          input_desc.handedness = device.mojom.XRHandedness.RIGHT;
          break;
        default:
          input_desc.handedness = device.mojom.XRHandedness.NONE;
          break;
      }

      input_desc.inputFromPointer = this.input_from_pointer_;

      input_desc.profiles = this.profiles_;

      input_state.description = input_desc;

      this.desc_dirty_ = false;
    }

    // Pointer data for DOM Overlay, set by setOverlayPointerPosition()
    if (this.overlay_pointer_position_) {
      input_state.overlayPointerPosition = this.overlay_pointer_position_;
    }

    return input_state;
  }

  setOverlayPointerPosition(x, y) {
    this.overlay_pointer_position_ = {x: x, y: y};
  }

  getEmptyGamepad() {
    // Mojo complains if some of the properties on Gamepad are null, so set
    // everything to reasonable defaults that tests can override.
    const gamepad = new device.mojom.Gamepad();
    gamepad.connected = true;
    gamepad.id = "";
    gamepad.timestamp = 0;
    gamepad.axes = [];
    gamepad.buttons = [];
    gamepad.mapping = "xr-standard";
    gamepad.display_id = 0;

    switch (this.handedness_) {
      case 'left':
      gamepad.hand = device.mojom.GamepadHand.GamepadHandLeft;
      break;
      case 'right':
      gamepad.hand = device.mojom.GamepadHand.GamepadHandRight;
      break;
      default:
      gamepad.hand = device.mojom.GamepadHand.GamepadHandNone;
      break;
    }

    return gamepad;
  }

  addGamepadButton(buttonState) {
    if (buttonState == null) {
      return;
    }

    const buttonIndex = this.getButtonIndex(buttonState.buttonType);
    const axesStartIndex = this.getAxesStartIndex(buttonState.buttonType);

    if (buttonIndex == -1) {
      throw new Error("Unknown Button Type!");
    }

    this.gamepad_.buttons[buttonIndex] = {
      pressed: buttonState.pressed,
      touched: buttonState.touched,
      value: buttonState.pressedValue
    };

    // Add x/y value if supported.
    if (axesStartIndex != -1) {
      this.gamepad_.axes[axesStartIndex] = (buttonState.xValue == null ? 0.0 : buttonSate.xValue);
      this.gamepad_.axes[axesStartIndex + 1] = (buttonState.yValue == null ? 0.0 : buttonSate.yValue);
    }
  }

  // General Helper methods
  getButtonIndex(buttonType) {
    switch (buttonType) {
      case 'grip':
        return 1;
      case 'touchpad':
        return 2;
      case 'thumbstick':
        return 3;
      case 'optional-button':
        return 4;
      case 'optional-thumbstick':
        return 5;
      default:
        return -1;
    }
  }

  getAxesStartIndex(buttonType) {
    switch (buttonType) {
      case 'touchpad':
        return 0;
      case 'thumbstick':
        return 2;
      case 'optional-thumbstick':
        return 4;
      default:
        return -1;
    }
  }
}

// Mojo helper classes
class MockXRPresentationProvider {
  constructor() {
    this.binding_ = new mojo.Binding(device.mojom.XRPresentationProvider, this);

    this.submit_frame_count_ = 0;
    this.missing_frame_count_ = 0;
  }

  bindProvider(request) {
    const providerPtr = new device.mojom.XRPresentationProviderPtr();
    const providerRequest = mojo.makeRequest(providerPtr);

    this.binding_.close();

    this.binding_ = new mojo.Binding(
        device.mojom.XRPresentationProvider, this, providerRequest);

    return providerPtr;
  }

  getClientReceiver() {
    this.submitFrameClient_ = new device.mojom.XRPresentationClientPtr();
    return mojo.makeRequest(this.submitFrameClient_);
  }

  // XRPresentationProvider mojo implementation
  submitFrameMissing(frameId, mailboxHolder, timeWaited) {
    this.missing_frame_count_++;
  }

  submitFrame(frameId, mailboxHolder, timeWaited) {
    this.submit_frame_count_++;

    // Trigger the submit completion callbacks here. WARNING: The
    // Javascript-based mojo mocks are *not* re-entrant. It's OK to
    // wait for these notifications on the next frame, but waiting
    // within the current frame would never finish since the incoming
    // calls would be queued until the current execution context finishes.
    this.submitFrameClient_.onSubmitFrameTransferred(true);
    this.submitFrameClient_.onSubmitFrameRendered();
  }

  // Utility methods
  Close() {
    this.binding_.close();
  }
}

// This is a temporary workaround for the fact that spinning up webxr before
// the mojo interceptors are created will cause the interceptors to not get
// registered, so we have to create this before we query xr;
const XRTest = new ChromeXRTest();

// This test API is also used to run Chrome's internal legacy VR tests; however,
// those fail if navigator.xr has been used. Those tests will set a bool telling
// us not to try to check navigator.xr
if ((typeof legacy_vr_test === 'undefined') || !legacy_vr_test) {
  // Some tests may run in the http context where navigator.xr isn't exposed
  // This should just be to test that it isn't exposed, but don't try to set up
  // the test framework in this case.
  if (navigator.xr) {
    navigator.xr.test = XRTest;
  }
} else {
  navigator.vr = { test: XRTest };
}
