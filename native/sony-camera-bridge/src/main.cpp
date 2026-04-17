#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  pragma comment(lib, "Ws2_32.lib")
#else
#  include <arpa/inet.h>
#  include <csignal>
#  include <netinet/in.h>
#  include <sys/select.h>
#  include <sys/socket.h>
#  include <unistd.h>
#endif

#include "CameraRemote_SDK.h"
#include "IDeviceCallback.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <locale>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#ifndef _WIN32
// POSIX compatibility shims so the rest of the file compiles unchanged.
using SOCKET = int;
constexpr int INVALID_SOCKET = -1;
constexpr int SOCKET_ERROR   = -1;
inline int closesocket(int fd) { return ::close(fd); }
#endif

namespace SDK = SCRSDK;

namespace {

std::atomic<bool> running{true};
constexpr const char* kBoundary = "lposframe";

struct CameraIdentity {
  std::string host;
  std::string model;
  std::string username;
  std::string password;
  std::string fingerprint;
};

struct CameraStatus {
  std::string cameraStatus{"IDLE"};
  bool recording{false};
  std::optional<int> batteryPercent{};
  std::optional<int> remainingSeconds{};
  std::optional<std::string> whiteBalance{};
  std::optional<std::string> isoSpeedRate{};
};

struct DiscoveredCamera {
  std::string name;
  std::string model;
  std::string host;
  std::string connectionType;
  std::string id;
  std::string macAddress;
  bool sshSupported{false};
};

struct CameraOptions {
  std::vector<std::pair<std::uint16_t, std::string>> whiteBalance;
  std::vector<std::pair<std::uint32_t, std::string>> iso;
};

struct HttpRequest {
  std::string method;
  std::string path;
  std::string query;
  std::string body;
};

std::string trim(const std::string& value) {
  const auto start = value.find_first_not_of(" \r\n\t");
  if (start == std::string::npos) return {};
  const auto end = value.find_last_not_of(" \r\n\t");
  return value.substr(start, end - start + 1);
}

std::string sdkText(const CrChar* value, CrInt32u size = 0) {
  if (value == nullptr) return {};
#if defined(UNICODE) || defined(_UNICODE)
  const auto convert = [](const std::wstring& wide) {
    if (wide.empty()) return std::string{};

    std::mbstate_t state{};
    const wchar_t* source = wide.c_str();
    size_t required = 0;
    if (std::wcsrtombs(nullptr, &source, 0, &state) == static_cast<size_t>(-1)) {
      return std::string{};
    }

    source = wide.c_str();
    state = std::mbstate_t{};
    required = std::wcsrtombs(nullptr, &source, 0, &state);
    std::string result(required, '\0');
    source = wide.c_str();
    state = std::mbstate_t{};
    std::wcsrtombs(result.data(), &source, result.size(), &state);
    return result;
  };

  if (size > 0) {
    const auto length = static_cast<size_t>(size);
    const auto trimmed = length > 0 && value[length - 1] == 0 ? length - 1 : length;
    return convert(std::wstring(value, value + trimmed));
  }
  return convert(std::wstring(value));
#else
  if (size > 0) {
    const auto length = static_cast<size_t>(size);
    const auto trimmed = length > 0 && value[length - 1] == 0 ? length - 1 : length;
    return std::string(value, value + trimmed);
  }
  return std::string(value);
#endif
}

std::string jsonEscape(const std::string& value) {
  std::ostringstream escaped;
  for (const char ch : value) {
    switch (ch) {
      case '\\': escaped << "\\\\"; break;
      case '"': escaped << "\\\""; break;
      case '\n': escaped << "\\n"; break;
      case '\r': escaped << "\\r"; break;
      case '\t': escaped << "\\t"; break;
      default: escaped << ch; break;
    }
  }
  return escaped.str();
}

std::string jsonResponse(
  int statusCode,
  const std::string& statusText,
  const std::string& body,
  const std::string& contentType = "application/json"
) {
  std::ostringstream response;
  response
    << "HTTP/1.1 " << statusCode << ' ' << statusText << "\r\n"
    << "Content-Type: " << contentType << "\r\n"
    << "Content-Length: " << body.size() << "\r\n"
    << "Connection: close\r\n\r\n"
    << body;
  return response.str();
}

std::string badRequest(const std::string& message) {
  return jsonResponse(400, "Bad Request", "{\"error\":\"" + jsonEscape(message) + "\"}");
}

std::string serviceUnavailable(const std::string& message) {
  return jsonResponse(503, "Service Unavailable", "{\"error\":\"" + jsonEscape(message) + "\"}");
}

std::string notImplemented(const std::string& message) {
  return jsonResponse(501, "Not Implemented", "{\"error\":\"" + jsonEscape(message) + "\"}");
}

bool sendAll(SOCKET socket, const char* data, int length) {
  int sent = 0;
  while (sent < length) {
    const int chunk = send(socket, data + sent, length - sent, 0);
    if (chunk == SOCKET_ERROR || chunk == 0) return false;
    sent += chunk;
  }
  return true;
}

std::optional<std::uint32_t> tryParseUint(const std::string& text) {
  try {
    size_t consumed = 0;
    const unsigned long value = std::stoul(text, &consumed, 10);
    if (consumed != text.size()) return std::nullopt;
    return static_cast<std::uint32_t>(value);
  } catch (...) {
    return std::nullopt;
  }
}

std::string getQueryParam(const std::string& query, const std::string& key) {
  std::string pattern = key + "=";
  size_t start = 0;
  while (start < query.size()) {
    const size_t amp = query.find('&', start);
    const size_t end = amp == std::string::npos ? query.size() : amp;
    const std::string part = query.substr(start, end - start);
    if (part.rfind(pattern, 0) == 0) {
      return part.substr(pattern.size());
    }
    if (amp == std::string::npos) break;
    start = amp + 1;
  }
  return {};
}

std::string getJsonString(const std::string& body, const std::string& key) {
  const std::string quotedKey = "\"" + key + "\"";
  const size_t keyPos = body.find(quotedKey);
  if (keyPos == std::string::npos) return {};

  const size_t colon = body.find(':', keyPos + quotedKey.size());
  if (colon == std::string::npos) return {};

  size_t valueStart = body.find('"', colon + 1);
  if (valueStart == std::string::npos) return {};
  ++valueStart;

  std::string value;
  bool escape = false;
  for (size_t i = valueStart; i < body.size(); ++i) {
    const char ch = body[i];
    if (escape) {
      value.push_back(ch);
      escape = false;
      continue;
    }
    if (ch == '\\') {
      escape = true;
      continue;
    }
    if (ch == '"') {
      return value;
    }
    value.push_back(ch);
  }
  return {};
}

HttpRequest parseRequest(const std::string& raw) {
  HttpRequest request{};

  const size_t lineEnd = raw.find("\r\n");
  const std::string requestLine = lineEnd == std::string::npos ? raw : raw.substr(0, lineEnd);
  std::istringstream lineStream(requestLine);
  std::string target;
  lineStream >> request.method >> target;

  const size_t queryPos = target.find('?');
  if (queryPos == std::string::npos) {
    request.path = target;
  } else {
    request.path = target.substr(0, queryPos);
    request.query = target.substr(queryPos + 1);
  }

  const size_t headerEnd = raw.find("\r\n\r\n");
  request.body = headerEnd == std::string::npos ? std::string{} : raw.substr(headerEnd + 4);
  return request;
}

std::string formatIso(std::uint32_t value) {
  const std::uint32_t raw = value & 0x00FFFFFFu;
  if (raw == SDK::CrISO_AUTO) return "AUTO";
  return std::to_string(raw);
}

std::string formatWhiteBalance(std::uint16_t value) {
  switch (value) {
    case SDK::CrWhiteBalance_AWB: return "Auto";
    case SDK::CrWhiteBalance_Daylight: return "Daylight";
    case SDK::CrWhiteBalance_Shadow: return "Shadow";
    case SDK::CrWhiteBalance_Cloudy: return "Cloudy";
    case SDK::CrWhiteBalance_Tungsten: return "Tungsten";
    case SDK::CrWhiteBalance_Fluorescent: return "Fluorescent";
    case SDK::CrWhiteBalance_Fluorescent_WarmWhite: return "Fluorescent Warm White";
    case SDK::CrWhiteBalance_Fluorescent_CoolWhite: return "Fluorescent Cool White";
    case SDK::CrWhiteBalance_Fluorescent_DayWhite: return "Fluorescent Day White";
    case SDK::CrWhiteBalance_Fluorescent_Daylight: return "Fluorescent Daylight";
    case SDK::CrWhiteBalance_Flush: return "Flash";
    case SDK::CrWhiteBalance_ColorTemp: return "Color Temperature";
    case SDK::CrWhiteBalance_Custom_1: return "Custom 1";
    case SDK::CrWhiteBalance_Custom_2: return "Custom 2";
    case SDK::CrWhiteBalance_Custom_3: return "Custom 3";
    case SDK::CrWhiteBalance_Custom: return "Custom";
    default: return "WB-" + std::to_string(value);
  }
}

std::string toLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

SDK::CrCameraDeviceModelList resolveModel(const std::string& model) {
  if (model == "fx3") return SDK::CrCameraDeviceModel_ILME_FX3;
  return SDK::CrCameraDeviceModel_ILME_FX6;
}

std::string normalizeModel(const std::string& model) {
  const std::string lower = toLower(model);
  if (lower.find("fx3") != std::string::npos) return "fx3";
  return "fx6";
}

std::optional<CrInt32u> parseIpAddress(const std::string& host) {
  std::array<std::uint32_t, 4> segments{};
  std::istringstream stream(host);
  std::string segment;

  for (size_t i = 0; i < segments.size(); ++i) {
    if (!std::getline(stream, segment, '.')) return std::nullopt;
    const auto value = tryParseUint(segment);
    if (!value || *value > 255u) return std::nullopt;
    segments[i] = *value;
  }

  if (std::getline(stream, segment, '.')) return std::nullopt;

  CrInt32u address = 0;
  for (size_t i = 0; i < segments.size(); ++i) {
    address += (segments[i] << (8u * static_cast<std::uint32_t>(i)));
  }
  return address;
}

std::string formatIpAddress(CrInt32u address) {
  std::ostringstream host;
  host
    << (address & 0xFFu) << '.'
    << ((address >> 8u) & 0xFFu) << '.'
    << ((address >> 16u) & 0xFFu) << '.'
    << ((address >> 24u) & 0xFFu);
  return host.str();
}

template <typename T>
std::vector<T> readPropertyValues(const unsigned char* data, std::size_t count) {
  std::vector<T> values(count);
  if (count > 0) {
    std::memcpy(values.data(), data, count * sizeof(T));
  }
  return values;
}

class DeviceCallback : public SDK::IDeviceCallback {
public:
  void OnConnected(SDK::DeviceConnectionVersioin) override {
    connected.store(true);
    lastError.store(SDK::CrError_None);
  }

  void OnDisconnected(CrInt32u error) override {
    connected.store(false);
    lastError.store(error);
  }

  void OnError(CrInt32u error) override {
    lastError.store(error);
  }

  bool isConnected() const {
    return connected.load();
  }

  SDK::CrError error() const {
    return static_cast<SDK::CrError>(lastError.load());
  }

private:
  std::atomic<bool> connected{false};
  std::atomic<std::uint32_t> lastError{SDK::CrError_None};
};

class CameraSession {
public:
  CameraSession(
    std::string hostValue,
    std::string modelValue,
    std::string usernameValue,
    std::string passwordValue,
    std::string fingerprintValue
  )
    : host(std::move(hostValue))
    , model(std::move(modelValue))
    , username(std::move(usernameValue))
    , password(std::move(passwordValue))
    , fingerprint(std::move(fingerprintValue))
  {}

  ~CameraSession() {
    close();
  }

  void ensureConnected() {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();
  }

  CameraOptions getOptions() {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();
    return fetchOptionsLocked();
  }

  CameraStatus getStatus() {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();

    CameraStatus status{};
    const std::array<CrInt32u, 5> codes{
      SDK::CrDevicePropertyCode::CrDeviceProperty_RecordingState,
      SDK::CrDevicePropertyCode::CrDeviceProperty_WhiteBalance,
      SDK::CrDevicePropertyCode::CrDeviceProperty_IsoSensitivity,
      SDK::CrDevicePropertyCode::CrDeviceProperty_BatteryLevel,
      SDK::CrDevicePropertyCode::CrDeviceProperty_MediaSLOT1_RemainingTime,
    };
    SDK::CrDeviceProperty* properties = nullptr;
    CrInt32 count = 0;
    const SDK::CrError error = SDK::GetSelectDeviceProperties(handle, static_cast<CrInt32u>(codes.size()), const_cast<CrInt32u*>(codes.data()), &properties, &count);
    if (CR_FAILED(error)) {
      throw std::runtime_error("Failed to load camera status from Sony SDK.");
    }

    for (CrInt32 index = 0; index < count; ++index) {
      const SDK::CrDeviceProperty property = properties[index];
      switch (property.GetCode()) {
        case SDK::CrDevicePropertyCode::CrDeviceProperty_RecordingState: {
          const auto recordingState = static_cast<std::uint16_t>(property.GetCurrentValue());
          status.recording = recordingState == SDK::CrMovie_Recording_State_Recording;
          if (recordingState == SDK::CrMovie_Recording_State_Recording) {
            status.cameraStatus = "MovieRecording";
          } else if (recordingState == SDK::CrMovie_Recording_State_IntervalRec_Waiting_Record) {
            status.cameraStatus = "MovieWaitRecStart";
          } else {
            status.cameraStatus = "IDLE";
          }
          break;
        }
        case SDK::CrDevicePropertyCode::CrDeviceProperty_WhiteBalance:
          status.whiteBalance = formatWhiteBalance(static_cast<std::uint16_t>(property.GetCurrentValue()));
          break;
        case SDK::CrDevicePropertyCode::CrDeviceProperty_IsoSensitivity:
          status.isoSpeedRate = formatIso(static_cast<std::uint32_t>(property.GetCurrentValue()));
          break;
        case SDK::CrDevicePropertyCode::CrDeviceProperty_BatteryLevel:
          status.batteryPercent = static_cast<int>(property.GetCurrentValue());
          break;
        case SDK::CrDevicePropertyCode::CrDeviceProperty_MediaSLOT1_RemainingTime:
          status.remainingSeconds = static_cast<int>(property.GetCurrentValue());
          break;
        default:
          break;
      }
    }

    SDK::ReleaseDeviceProperties(handle, properties);
    return status;
  }

  void startRecording() {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();
    const SDK::CrError error = SDK::SendCommand(handle, SDK::CrCommandId_MovieRecord, SDK::CrCommandParam_Down);
    if (CR_FAILED(error)) {
      throw std::runtime_error("Sony SDK failed to start recording.");
    }
  }

  void stopRecording() {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();
    const SDK::CrError error = SDK::SendCommand(handle, SDK::CrCommandId_MovieRecord, SDK::CrCommandParam_Up);
    if (CR_FAILED(error)) {
      throw std::runtime_error("Sony SDK failed to stop recording.");
    }
  }

  void setWhiteBalance(const std::string& mode) {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();
    const auto options = cachedOptions.whiteBalance.empty() ? fetchOptionsLocked().whiteBalance : cachedOptions.whiteBalance;
    std::optional<std::uint16_t> value{};
    for (const auto& option : options) {
      if (option.second == mode) {
        value = option.first;
        break;
      }
    }
    if (!value) {
      const auto parsed = tryParseUint(mode);
      if (parsed && *parsed <= 0xFFFFu) {
        value = static_cast<std::uint16_t>(*parsed);
      }
    }
    if (!value) {
      throw std::runtime_error("Unsupported white balance mode: " + mode);
    }

    SDK::CrDeviceProperty property;
    property.SetCode(SDK::CrDevicePropertyCode::CrDeviceProperty_WhiteBalance);
    property.SetCurrentValue(*value);
    property.SetValueType(SDK::CrDataType_UInt16Array);
    const SDK::CrError error = SDK::SetDeviceProperty(handle, &property);
    if (CR_FAILED(error)) {
      throw std::runtime_error("Sony SDK failed to set white balance.");
    }
  }

  void setIso(const std::string& iso) {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();
    const auto options = cachedOptions.iso.empty() ? fetchOptionsLocked().iso : cachedOptions.iso;
    std::optional<std::uint32_t> value{};
    for (const auto& option : options) {
      if (option.second == iso) {
        value = option.first;
        break;
      }
    }
    if (!value) {
      if (trim(iso) == "AUTO") {
        value = SDK::CrISO_AUTO;
      } else {
        value = tryParseUint(iso);
      }
    }
    if (!value) {
      throw std::runtime_error("Unsupported ISO value: " + iso);
    }

    SDK::CrDeviceProperty property;
    property.SetCode(SDK::CrDevicePropertyCode::CrDeviceProperty_IsoSensitivity);
    property.SetCurrentValue(*value);
    property.SetValueType(SDK::CrDataType_UInt32Array);
    const SDK::CrError error = SDK::SetDeviceProperty(handle, &property);
    if (CR_FAILED(error)) {
      throw std::runtime_error("Sony SDK failed to set ISO.");
    }
  }

  std::vector<std::uint8_t> getLiveViewFrame() {
    std::lock_guard<std::mutex> lock(mutex);
    ensureConnectedLocked();
    ensureLiveViewEnabledLocked();

    SDK::CrImageInfo info;
    SDK::CrError error = SDK::GetLiveViewImageInfo(handle, &info);
    if (CR_FAILED(error)) {
      throw std::runtime_error("Sony SDK failed to read liveview frame info.");
    }

    const CrInt32u bufferSize = info.GetBufferSize();
    if (bufferSize == 0) {
      throw std::runtime_error("Sony SDK returned an empty liveview buffer.");
    }

    std::vector<std::uint8_t> buffer(bufferSize);
    SDK::CrImageDataBlock imageData;
    imageData.SetSize(bufferSize);
    imageData.SetData(reinterpret_cast<CrInt8u*>(buffer.data()));

    error = SDK::GetLiveViewImage(handle, &imageData);
    if (error == SDK::CrWarning_Frame_NotUpdated) {
      return {};
    }
    if (CR_FAILED(error)) {
      throw std::runtime_error("Sony SDK failed to read liveview image.");
    }

    return std::vector<std::uint8_t>(
      reinterpret_cast<std::uint8_t*>(imageData.GetImageData()),
      reinterpret_cast<std::uint8_t*>(imageData.GetImageData()) + imageData.GetImageSize()
    );
  }

  void close() {
    std::lock_guard<std::mutex> lock(mutex);
    if (handle != 0) {
      SDK::Disconnect(handle);
      SDK::ReleaseDevice(handle);
      handle = 0;
    }
    if (cameraInfo != nullptr) {
      cameraInfo->Release();
      cameraInfo = nullptr;
    }
  }

private:
  CameraOptions fetchOptionsLocked() {
    CameraOptions options;
    const std::array<CrInt32u, 2> codes{
      SDK::CrDevicePropertyCode::CrDeviceProperty_WhiteBalance,
      SDK::CrDevicePropertyCode::CrDeviceProperty_IsoSensitivity,
    };
    SDK::CrDeviceProperty* properties = nullptr;
    CrInt32 count = 0;
    const SDK::CrError error = SDK::GetSelectDeviceProperties(handle, static_cast<CrInt32u>(codes.size()), const_cast<CrInt32u*>(codes.data()), &properties, &count);
    if (CR_FAILED(error)) {
      throw std::runtime_error("Failed to load camera options from Sony SDK.");
    }

    for (CrInt32 index = 0; index < count; ++index) {
      const SDK::CrDeviceProperty property = properties[index];
      if (property.GetCode() == SDK::CrDevicePropertyCode::CrDeviceProperty_WhiteBalance) {
        const auto values = readPropertyValues<std::uint16_t>(property.GetValues(), property.GetValueSize() / sizeof(std::uint16_t));
        options.whiteBalance.clear();
        for (const auto value : values) {
          options.whiteBalance.emplace_back(value, formatWhiteBalance(value));
        }
      }
      if (property.GetCode() == SDK::CrDevicePropertyCode::CrDeviceProperty_IsoSensitivity) {
        const auto values = readPropertyValues<std::uint32_t>(property.GetValues(), property.GetValueSize() / sizeof(std::uint32_t));
        options.iso.clear();
        for (const auto value : values) {
          options.iso.emplace_back(value, formatIso(value));
        }
      }
    }

    SDK::ReleaseDeviceProperties(handle, properties);
    cachedOptions = options;
    return options;
  }

  void ensureConnectedLocked() {
    if (handle != 0 && callback.isConnected()) return;

    std::cout << "[sony-camera-bridge] connecting to " << model << " at " << host << '\n';

    const auto ip = parseIpAddress(host);
    if (!ip) {
      throw std::runtime_error("Invalid camera host: " + host);
    }

    if (cameraInfo == nullptr) {
      std::array<CrInt8u, 6> macAddress{0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC};
      const CrInt32u sshSupport =
        (!username.empty() || !password.empty() || !fingerprint.empty())
          ? SDK::CrSSHsupport_ON
          : SDK::CrSSHsupport_OFF;
      const SDK::CrError createError = SDK::CreateCameraObjectInfoEthernetConnection(
        &cameraInfo,
        resolveModel(model),
        *ip,
        macAddress.data(),
        sshSupport
      );
      if (CR_FAILED(createError) || cameraInfo == nullptr) {
        throw std::runtime_error("Sony SDK could not create an Ethernet camera object for " + host + ".");
      }
    }

    const SDK::CrError connectError = SDK::Connect(
      cameraInfo,
      &callback,
      &handle,
      SDK::CrSdkControlMode_Remote,
      SDK::CrReconnecting_ON,
      username.empty() ? nullptr : username.c_str(),
      password.empty() ? nullptr : password.c_str(),
      fingerprint.empty() ? nullptr : fingerprint.c_str(),
      static_cast<CrInt32u>(fingerprint.size()),
      nullptr
    );
    if (CR_FAILED(connectError)) {
      throw std::runtime_error("Sony SDK could not connect to camera at " + host + ".");
    }

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(45);
    while (!callback.isConnected() && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    if (!callback.isConnected()) {
      std::ostringstream message;
      message
        << "Sony SDK connection to " << host
        << " did not become ready after 45 seconds. Check that the FX6 is in a Sony SDK-supported network remote mode and not locked in another remote-control mode.";
      throw std::runtime_error(message.str());
    }

    std::cout << "[sony-camera-bridge] connected to " << model << " at " << host << '\n';
  }

  void ensureLiveViewEnabledLocked() {
    if (liveViewEnabled) return;
    SDK::SetDeviceSetting(handle, SDK::Setting_Key_EnableLiveView, SDK::CrDeviceSetting_Enable);
    liveViewEnabled = true;
  }

  std::string host;
  std::string model;
  std::string username;
  std::string password;
  std::string fingerprint;
  std::mutex mutex;
  SDK::ICrCameraObjectInfo* cameraInfo{nullptr};
  SDK::CrDeviceHandle handle{0};
  DeviceCallback callback;
  CameraOptions cachedOptions{};
  bool liveViewEnabled{false};
};

class CameraManager {
public:
  CameraManager() {
    if (!SDK::Init()) {
      throw std::runtime_error("Failed to initialize Sony Camera Remote SDK.");
    }
    initialized = true;
  }

  ~CameraManager() {
    std::lock_guard<std::mutex> lock(mutex);
    sessions.clear();
    if (initialized) {
      SDK::Release();
    }
  }

  CameraSession& sessionFor(
    const std::string& host,
    const std::string& model,
    const std::string& username,
    const std::string& password,
    const std::string& fingerprint
  ) {
    std::lock_guard<std::mutex> lock(mutex);
    const std::string key = host + "|" + model + "|" + username + "|" + fingerprint;
    auto it = sessions.find(key);
    if (it == sessions.end()) {
      it = sessions.emplace(key, std::make_unique<CameraSession>(host, model, username, password, fingerprint)).first;
    }
    return *it->second;
  }

private:
  bool initialized{false};
  std::mutex mutex;
  std::unordered_map<std::string, std::unique_ptr<CameraSession>> sessions;
};

CameraManager& cameraManager() {
  static CameraManager manager;
  return manager;
}

std::string capabilityJson() {
  return R"({"capabilities":["getEvent","startMovieRec","stopMovieRec","getAvailableWhiteBalance","setWhiteBalance","getAvailableIsoSpeedRate","setIsoSpeedRate","startLiveview"]})";
}

std::string discoveryJson(const std::vector<DiscoveredCamera>& cameras) {
  std::ostringstream body;
  body << "{\"cameras\":[";
  for (size_t i = 0; i < cameras.size(); ++i) {
    if (i > 0) body << ',';
    const auto& camera = cameras[i];
    body
      << '{'
      << "\"name\":\"" << jsonEscape(camera.name) << "\","
      << "\"model\":\"" << jsonEscape(camera.model) << "\","
      << "\"host\":\"" << jsonEscape(camera.host) << "\","
      << "\"connectionType\":\"" << jsonEscape(camera.connectionType) << "\","
      << "\"id\":\"" << jsonEscape(camera.id) << "\","
      << "\"macAddress\":\"" << jsonEscape(camera.macAddress) << "\","
      << "\"sshSupported\":" << (camera.sshSupported ? "true" : "false")
      << '}';
  }
  body << "]}";
  return body.str();
}

std::vector<DiscoveredCamera> discoverCameras() {
  cameraManager();
  SDK::ICrEnumCameraObjectInfo* cameraList = nullptr;
  const SDK::CrError error = SDK::EnumCameraObjects(&cameraList);
  if (CR_FAILED(error) || cameraList == nullptr) {
    throw std::runtime_error("Sony SDK did not find any cameras.");
  }

  std::vector<DiscoveredCamera> cameras;
  const CrInt32u count = cameraList->GetCount();
  std::cout << "[sony-camera-bridge] discovered " << count << " camera object(s)\n";
  cameras.reserve(count);
  for (CrInt32u i = 0; i < count; ++i) {
    const auto* cameraInfo = cameraList->GetCameraObjectInfo(i);
    if (cameraInfo == nullptr) continue;

    DiscoveredCamera camera{};
    camera.name = sdkText(cameraInfo->GetName(), cameraInfo->GetNameSize());
    camera.model = normalizeModel(sdkText(cameraInfo->GetModel(), cameraInfo->GetModelSize()));
    camera.connectionType = sdkText(cameraInfo->GetConnectionTypeName());
    camera.sshSupported = cameraInfo->GetSSHsupport() == SDK::CrSSHsupport_ON;
    if (camera.connectionType == "IP") {
      camera.host = formatIpAddress(cameraInfo->GetIPAddress());
      camera.macAddress = sdkText(cameraInfo->GetMACAddressChar(), cameraInfo->GetMACAddressCharSize());
      camera.id = camera.macAddress.empty() ? camera.host : camera.macAddress;
    } else {
      camera.id = "non-ip-camera";
    }

    if (!camera.host.empty()) {
      cameras.push_back(std::move(camera));
    }
  }

  cameraList->Release();
  return cameras;
}

std::string statusJson(const CameraStatus& status) {
  std::ostringstream body;
  body << "{"
       << "\"cameraStatus\":\"" << jsonEscape(status.cameraStatus) << "\","
       << "\"recording\":" << (status.recording ? "true" : "false") << ','
       << "\"batteryPercent\":";
  if (status.batteryPercent) body << *status.batteryPercent; else body << "null";
  body << ",\"remainingSeconds\":";
  if (status.remainingSeconds) body << *status.remainingSeconds; else body << "null";
  body << ",\"whiteBalance\":";
  if (status.whiteBalance) body << "\"" << jsonEscape(*status.whiteBalance) << "\""; else body << "null";
  body << ",\"isoSpeedRate\":";
  if (status.isoSpeedRate) body << "\"" << jsonEscape(*status.isoSpeedRate) << "\""; else body << "null";
  body << '}';
  return body.str();
}

template <typename T>
std::string optionsJson(const std::vector<std::pair<T, std::string>>& options) {
  std::ostringstream body;
  body << "{\"options\":[";
  for (size_t i = 0; i < options.size(); ++i) {
    if (i > 0) body << ',';
    body << "\"" << jsonEscape(options[i].second) << "\"";
  }
  body << "]}";
  return body.str();
}

std::pair<std::string, std::string> readIdentity(const HttpRequest& request) {
  std::string host = trim(getJsonString(request.body, "host"));
  std::string model = trim(getJsonString(request.body, "model"));

  if (host.empty()) host = trim(getQueryParam(request.query, "host"));
  if (model.empty()) model = trim(getQueryParam(request.query, "model"));
  if (model.empty()) model = "fx6";
  return {host, model};
}

std::pair<std::string, std::string> readCredentials(const HttpRequest& request) {
  std::string username = trim(getJsonString(request.body, "username"));
  std::string password = getJsonString(request.body, "password");
  if (username.empty()) username = trim(getQueryParam(request.query, "username"));
  if (password.empty()) password = getQueryParam(request.query, "password");
  return {username, password};
}

std::string readFingerprint(const HttpRequest& request) {
  std::string fingerprint = getJsonString(request.body, "fingerprint");
  if (fingerprint.empty()) fingerprint = getQueryParam(request.query, "fingerprint");
  fingerprint.erase(
    std::remove_if(
      fingerprint.begin(),
      fingerprint.end(),
      [](unsigned char ch) { return std::isspace(ch) != 0; }
    ),
    fingerprint.end()
  );
  return fingerprint;
}

std::string handleJsonRequest(const HttpRequest& request) {
  if (request.path == "/health") {
    return jsonResponse(
      200,
      "OK",
      R"({"ok":true,"provider":"sony-sdk-bridge","version":"0.2.0","status":"ready"})"
    );
  }

  if (request.path == "/camera/rpc") {
    return notImplemented("Generic RPC forwarding is not implemented yet in the Sony SDK bridge.");
  }

  if (request.path == "/camera/discover") {
    return jsonResponse(200, "OK", discoveryJson(discoverCameras()));
  }

  const auto [host, model] = readIdentity(request);
  if (host.empty()) {
    return badRequest("Camera host is required.");
  }

  try {
    const auto [username, password] = readCredentials(request);
    const auto fingerprint = readFingerprint(request);
    auto& session = cameraManager().sessionFor(host, model, username, password, fingerprint);

    if (request.path == "/camera/capabilities") {
      session.ensureConnected();
      return jsonResponse(200, "OK", capabilityJson());
    }

    if (request.path == "/camera/status") {
      return jsonResponse(200, "OK", statusJson(session.getStatus()));
    }

    if (request.path == "/camera/record/start") {
      session.startRecording();
      return jsonResponse(200, "OK", R"({"ok":true})");
    }

    if (request.path == "/camera/record/stop") {
      session.stopRecording();
      return jsonResponse(200, "OK", R"({"ok":true})");
    }

    if (request.path == "/camera/settings/white-balance/options") {
      const auto options = session.getOptions();
      return jsonResponse(200, "OK", optionsJson(options.whiteBalance));
    }

    if (request.path == "/camera/settings/white-balance") {
      const std::string mode = trim(getJsonString(request.body, "mode"));
      if (mode.empty()) return badRequest("White balance mode is required.");
      session.setWhiteBalance(mode);
      return jsonResponse(200, "OK", R"({"ok":true})");
    }

    if (request.path == "/camera/settings/iso/options") {
      const auto options = session.getOptions();
      return jsonResponse(200, "OK", optionsJson(options.iso));
    }

    if (request.path == "/camera/settings/iso") {
      const std::string iso = trim(getJsonString(request.body, "iso"));
      if (iso.empty()) return badRequest("ISO value is required.");
      session.setIso(iso);
      return jsonResponse(200, "OK", R"({"ok":true})");
    }
  } catch (const std::exception& error) {
    return serviceUnavailable(error.what());
  }

  return jsonResponse(404, "Not Found", R"({"error":"Not found"})");
}

bool readHttpRequest(SOCKET client, std::string& rawRequest) {
  std::array<char, 8192> buffer{};
  rawRequest.clear();

  size_t contentLength = 0;
  bool headerParsed = false;

  for (;;) {
    const int received = recv(client, buffer.data(), static_cast<int>(buffer.size()), 0);
    if (received <= 0) return false;
    rawRequest.append(buffer.data(), received);

    const size_t headerEnd = rawRequest.find("\r\n\r\n");
    if (headerEnd == std::string::npos) continue;

    if (!headerParsed) {
      headerParsed = true;
      const std::string headers = rawRequest.substr(0, headerEnd);
      const std::string contentLengthKey = "Content-Length:";
      const size_t pos = headers.find(contentLengthKey);
      if (pos != std::string::npos) {
        size_t valueStart = pos + contentLengthKey.size();
        size_t valueEnd = headers.find("\r\n", valueStart);
        const std::string value = trim(headers.substr(valueStart, valueEnd - valueStart));
        if (const auto parsed = tryParseUint(value)) {
          contentLength = *parsed;
        }
      }
    }

    const size_t bodyBytes = rawRequest.size() - (headerEnd + 4);
    if (bodyBytes >= contentLength) {
      return true;
    }
  }
}

bool streamLiveView(SOCKET client, const CameraIdentity& identity) {
  auto& session = cameraManager().sessionFor(
    identity.host,
    identity.model,
    identity.username,
    identity.password,
    identity.fingerprint
  );
  try {
    session.ensureConnected();
  } catch (const std::exception& error) {
    const std::string response = serviceUnavailable(error.what());
    return sendAll(client, response.c_str(), static_cast<int>(response.size()));
  }

  std::ostringstream headers;
  headers
    << "HTTP/1.1 200 OK\r\n"
    << "Content-Type: multipart/x-mixed-replace; boundary=" << kBoundary << "\r\n"
    << "Cache-Control: no-cache, no-store, must-revalidate\r\n"
    << "Connection: close\r\n\r\n";
  const std::string responseHeaders = headers.str();
  if (!sendAll(client, responseHeaders.c_str(), static_cast<int>(responseHeaders.size()))) {
    return false;
  }

  while (running.load()) {
    std::vector<std::uint8_t> frame;
    try {
      frame = session.getLiveViewFrame();
    } catch (const std::exception& error) {
      std::cerr << "[sony-camera-bridge] liveview error: " << error.what() << '\n';
      return false;
    }

    if (frame.empty()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(40));
      continue;
    }

    std::ostringstream frameHeaders;
    frameHeaders
      << "--" << kBoundary << "\r\n"
      << "Content-Type: image/jpeg\r\n"
      << "Content-Length: " << frame.size() << "\r\n\r\n";

    const std::string headerBlock = frameHeaders.str();
    if (!sendAll(client, headerBlock.c_str(), static_cast<int>(headerBlock.size()))) return false;
    if (!sendAll(client, reinterpret_cast<const char*>(frame.data()), static_cast<int>(frame.size()))) return false;
    if (!sendAll(client, "\r\n", 2)) return false;

    std::this_thread::sleep_for(std::chrono::milliseconds(40));
  }

  return true;
}

#ifdef _WIN32
BOOL WINAPI onConsoleSignal(DWORD signal) {
  switch (signal) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_SHUTDOWN_EVENT:
      running = false;
      return TRUE;
    default:
      return FALSE;
  }
}
#endif

} // namespace

int main(int argc, char* argv[]) {
  int port = 6107;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--port" && i + 1 < argc) {
      port = std::atoi(argv[++i]);
    }
  }

#ifdef _WIN32
  SetConsoleCtrlHandler(onConsoleSignal, TRUE);
#else
  std::signal(SIGINT,  [](int) { running = false; });
  std::signal(SIGTERM, [](int) { running = false; });
#endif

#ifdef _WIN32
  WSADATA wsaData{};
  if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
    std::cerr << "[sony-camera-bridge] WSAStartup failed\n";
    return 1;
  }
#endif

  SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (server == INVALID_SOCKET) {
    std::cerr << "[sony-camera-bridge] socket() failed\n";
#ifdef _WIN32
    WSACleanup();
#endif
    return 1;
  }

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<u_short>(port));
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

  constexpr int reuseAddress = 1;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuseAddress), sizeof(reuseAddress));

  if (bind(server, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR) {
    std::cerr << "[sony-camera-bridge] bind() failed on 127.0.0.1:" << port << '\n';
    closesocket(server);
#ifdef _WIN32
    WSACleanup();
#endif
    return 1;
  }

  if (listen(server, SOMAXCONN) == SOCKET_ERROR) {
    std::cerr << "[sony-camera-bridge] listen() failed\n";
    closesocket(server);
#ifdef _WIN32
    WSACleanup();
#endif
    return 1;
  }

  std::cout << "[sony-camera-bridge] listening on http://127.0.0.1:" << port << '\n';
  std::cout << "[sony-camera-bridge] Sony SDK bridge ready\n";

  while (running) {
    fd_set readSet;
    FD_ZERO(&readSet);
    FD_SET(server, &readSet);

    timeval timeout{};
    timeout.tv_sec = 1;
    timeout.tv_usec = 0;

#ifdef _WIN32
    // On Windows the first argument to select() is ignored.
    const int ready = select(0, &readSet, nullptr, nullptr, &timeout);
#else
    // On POSIX, nfds must be the highest fd + 1.
    const int ready = select(server + 1, &readSet, nullptr, nullptr, &timeout);
#endif
    if (ready <= 0) continue;

    SOCKET client = accept(server, nullptr, nullptr);
    if (client == INVALID_SOCKET) continue;

    std::thread([client]() {
      std::string rawRequest;
      if (!readHttpRequest(client, rawRequest)) {
        closesocket(client);
        return;
      }

      const HttpRequest request = parseRequest(rawRequest);
      if (request.path == "/camera/liveview") {
        const auto [host, model] = readIdentity(request);
        if (host.empty()) {
          const std::string response = badRequest("Camera host is required.");
          sendAll(client, response.c_str(), static_cast<int>(response.size()));
        } else {
          const auto [username, password] = readCredentials(request);
          const auto fingerprint = readFingerprint(request);
          streamLiveView(client, CameraIdentity{host, model, username, password, fingerprint});
        }
        closesocket(client);
        return;
      }

      const std::string response = handleJsonRequest(request);
      sendAll(client, response.c_str(), static_cast<int>(response.size()));
      closesocket(client);
    }).detach();
  }

  closesocket(server);
#ifdef _WIN32
  WSACleanup();
#endif
  return 0;
}
