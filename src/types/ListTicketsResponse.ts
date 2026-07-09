export interface ListTicketsResponse {
    ID:                string;
    licenseID:         number;
    shortID:           string;
    createdAt:         Date;
    createdBy:         string;
    createdByType:     string;
    updatedAt:         Date;
    updatedBy:         string;
    lastMessageAt:     Date;
    parentTicket:      null;
    childTickets:      any[];
    status:            string;
    priority:          number;
    subject:           string;
    teamIDs:           string[];
    requester:         Requester;
    cc:                any[];
    assignment:        NewClass;
    tagIDs:            any[];
    followers:         any[];
    ratingRequestSent: boolean;
    rating:            null;
    spam:              Spam;
    events:            Event[];
    source:            Source;
    integrations:      Integrations;
    detectedLanguage:  null | string;
}

export interface NewClass {
    team:  Team;
    agent: Team | null;
}

export interface Team {
    ID:   string;
    name: string;
}

export interface Event {
    ID:              number;
    type:            EventType;
    source:          Source;
    date:            Date;
    author:          Author;
    message?:        Message;
    deliveryStatus?: DeliveryStatus[];
    status?:         Status;
    assignment?:     EventAssignment;
}

export interface EventAssignment {
    new: NewClass;
    old: Old;
}

export interface Old {
    team: Team;
}

export interface Author {
    type:   AuthorType;
    email?: string;
    ID?:    string;
    name?:  string;
}

export enum AuthorType {
    Agent = "agent",
    Client = "client",
}

export interface DeliveryStatus {
    entityID: string;
    status:   string;
    date:     Date;
}

export interface Message {
    isPrivate:    boolean;
    text:         string;
    richTextHtml: null | string;
    richTextObj:  RichTextObj[] | null;
    stripped?:    boolean;
}

export interface RichTextObj {
    type:     string;
    children: Child[];
}

export interface Child {
    text: string;
}

export interface Source {
    type:             SourceType;
    from?:            string;
    detailedSource:   string;
    integrationType?: string;
    external?:        boolean;
    referenceURL?:    string;
}

export enum SourceType {
    API = "api",
    Email = "email",
    Integration = "integration",
}

export interface Status {
    new: string;
    old: string;
}

export enum EventType {
    Assignment = "assignment",
    Message = "message",
    Status = "status",
}

export interface Integrations {
}

export interface Requester {
    email: string;
    name:  string;
}

export interface Spam {
    status: boolean;
    reason: null;
}